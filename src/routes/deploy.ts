import { Router } from "express";
import { QueryService } from "../services/query";
import { IDeployService } from "../services/deploy";
import { GitLabApi } from "../gitlab";
import { NewFullDeploy, GroupDeployChange } from "../models";
import { z } from "zod";
import { createLogger } from "../logger";
import { buildSchema, GraphQLInt, GraphQLObjectType, GraphQLSchema, GraphQLNonNull, GraphQLString, GraphQLList } from 'graphql';
import { createHandler } from 'graphql-http/lib/use/express';

export default function deployRouter(deployService: IDeployService) {
  const router = Router();
  const queryService = new QueryService();
  const gitlab = new GitLabApi();

  router.get("/", (_req, res) => {
    res.json({ ok: true, service: "ts-deploy-server" });
  });

  // Define DeployProject GraphQL type
  const DeployProjectType = new GraphQLObjectType({
    name: 'DeployProject',
    fields: {
      project_id: { type: GraphQLInt },
      project_name: { type: GraphQLString },
      branch: { type: GraphQLString },
      tag_prefix: { type: GraphQLString },
      actual_tag: { type: GraphQLString},
      pipeline_id: { type: GraphQLInt }
    }
  });
  const DeployPipelineType = new GraphQLObjectType({
    name: 'DeployPipeline',
    fields: {
      id: { type: GraphQLInt },
      deploy_id: { type: GraphQLInt },
      project_id: { type: GraphQLInt },
      pipeline_id: { type: GraphQLInt },
      status: { type: GraphQLString },
      user_name: { type: GraphQLString },
      created_at: { type: GraphQLString },
      updated_at: { type: GraphQLString },
    }
  });

  const DeployGroupType = new GraphQLObjectType({
    name: 'DeployGroup',
    fields: {
      group_index: { type: GraphQLInt },
      depend_group_index: { type: GraphQLInt },
      depend_type: { type: GraphQLString },
    }
  });
  const DeployInfoType = new GraphQLObjectType({
    name: 'Deploy',
    fields: {
      id : { type: GraphQLInt },
      status: {type: GraphQLString },
      description : { type: GraphQLString },
    }
  });

  const DeployType = new GraphQLObjectType({
    name: 'DeployDetail',
    fields: {
      id: { type: GraphQLInt },
      status: { type: GraphQLString },
      description: { type: GraphQLString },
      created_at : { type: GraphQLString},
      updated_at: { type: GraphQLString},
      groups: { type: new GraphQLList(DeployGroupType) },
      projects: { type: new GraphQLList(DeployProjectType) },
      pipelines: { type: new GraphQLList(DeployPipelineType) },
    }
  });

  const deployInfoSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query', 
      fields: {
        deployDetail: {
          type: DeployType,
          args: {
            id: { type: new GraphQLNonNull(GraphQLInt) }
          },
          resolve: async (_parent, args, _context) => {
            return await queryService.getDeployDetail(args.id)
          }
        },
        deploy: {
          type: DeployInfoType,
          args: { id : { type: new GraphQLNonNull(GraphQLInt) } },
          resolve: async (_parent, args, _context) => {
            // Example: get all deploys and flatten their groups
            const deploys = await queryService.getDeployInfo(args.id);
            // Flatten all groups from all deploys
            return deploys
          }
        },
        deploys: {
          type: new GraphQLList(DeployInfoType),
          resolve: async (_parent, _args, _context) => {
            // Example: get all deploys and flatten their groups
            const deploys = await queryService.getAllDeployInfoPage(0, 50);
            // Flatten all groups from all deploys
            return deploys
          }

        }
      }
    })
  });

  router.post("/graphql", createHandler(
    {
      schema: deployInfoSchema,
    }
  ))

  router.get("/deploys", async (_req, res) => {
    const list = await queryService.getAllDeployInfoPage(0, 50);
    res.json(list);
  });

  router.get("/deploy/:id", async (req, res) => {
    const id = Number(req.params.id);
    const one = await queryService.getDeployDetail(id);
    if (!one) return res.status(404).json({ error: "Not found" });
    res.json(one);
  });

  const newFullDeploySchema = z.object({
    description: z.string().optional(),
    groups: z.array(
      z.object({
        group_index: z.number(),
        depend_group_index: z.number(),
        depend_type: z.string().nullable().optional(),
      })
    ),
    projects: z.array(
      z.object({
        group_index: z.number(),
        project_id: z.number(),
        branch: z.string(),
        tag_prefix: z.string(),
        actual_tag: z.string().nullable().optional(),
        pipeline_id: z.number().nullable().optional(),
      })
    ),
  });

  type RawNewFullDeploy = z.infer<typeof newFullDeploySchema>;

  function toNewFullDeploy(input: RawNewFullDeploy): NewFullDeploy {
    return {
      description: input.description,
      groups: input.groups.map((g) => ({
        deploy_id: 0,
        group_index: g.group_index,
        depend_group_index: g.depend_group_index === 0 ? null : g.depend_group_index,
        depend_type: g.depend_type ?? null,
      })),
      projects: input.projects.map((p) => ({
        deploy_id: 0,
        project_id: p.project_id,
        project_name: "", // filled in service from project_info
        branch: p.branch,
        group_index: p.group_index,
        tag_prefix: p.tag_prefix,
        actual_tag: p.actual_tag ?? null,
        pipeline_id: p.pipeline_id ?? null,
      })),
    };
  }

  router.post("/deploy/create", async (req, res) => {
    const parsed = newFullDeploySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    try {
      const payload: NewFullDeploy = toNewFullDeploy(parsed.data);
      const id = await deployService.addFullDeploy(payload);
      res.json({ id });
    } catch (e: any) {
      res.status(400).json({ id: -1, error: e.message });
    }
  });

  const runDeploySchema = z.object({
    id: z.number(),
    host: z.string(),
    token: z.string(),
    scheme: z.string().optional(), // default https
  });

  router.post("/deploy/run", async (req, res) => {
    const parsed = runDeploySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

    const { id, host, token, scheme } = parsed.data;

    // Run in background and respond immediately
    (async () => {
      try {
        await deployService.runDeploy(id, host, token, scheme ?? "https");
      } catch (e) {
        console.error("Deploy run error:", e);
      }
    })();

    res.json({ ok: true, id });
  });

  router.post("/deploy/retry", async (req, res) => {
    const parsed = runDeploySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

    const { id, host, token, scheme } = parsed.data;
    try {
      const result = await deployService.retryFetch(id, host, token, scheme ?? "https");
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  router.post("/deploy/copy", async (req, res) => {
    const { from_id, description } = req.body || {};
    if (typeof from_id !== "number") return res.status(400).json({ id: -1 });
    try {
      const id = await deployService.copyDeployFromOld(from_id, description);
      res.json({ id });
    } catch (e: any) {
      res.status(400).json({ id: -1, error: e.message });
    }
  });

  router.post("/deploy/cancel", async (_req, res) => {
    const deploy_id = Number(_req.body?.id);
    if (typeof deploy_id !== "number") return res.status(400).json({ id: -1 });
    try {
      await deployService.cancelDeploy(deploy_id);
      res.json({ ok: true });
    } catch (e: any) {
      createLogger({ deploy_id }).error(`Cancel deploy error: ${e.message}`);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  router.get("/projects/:id/branches", async (req, res) => {
    const id = Number(req.params.id);
    const q = typeof req.query.branch === "string" ? req.query.branch : undefined;
    try {
      const branches = await gitlab.queryBranchesInProject(id, q);
      res.json(branches);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });
  // GroupDeployChange object
  const groupChangeSchema = z.object({
    deploy_id: z.number(),
    group_id: z.number().nullable().optional(),
    group_index: z.number(),
    depend_group_index: z.number().nullable().optional(),
    depend_type: z.string().nullable().optional(),
    description: z.string().optional(),
    projects: z.array(
      z.object({
        deploy_id: z.number(),
        project_id: z.number(),
        project_name: z.string(),
        branch: z.string(),
        tag_prefix: z.string(),
      })
    ),
  });

  function toNewGroupDeployChange(input: z.infer<typeof groupChangeSchema>): GroupDeployChange {
    return {
      deploy_id: input.deploy_id,
      group_id: input.group_id, // Use 0 if not provided
      group_index: input.group_index,
      depend_group_index: input.depend_group_index === 0 ? null : input.depend_group_index,
      description: input.description,
      depend_type: input.depend_type ?? null,
      projects: input.projects.map((p) => ({
        deploy_id: p.deploy_id,
        project_id: p.project_id,
        project_name: p.project_name,
        branch: p.branch,
        tag_prefix: p.tag_prefix,
      })),
    };
  }
          
      
  router.post("/deploy/group/change/:group_id", async (req, res) => {
    const groupId = Number(req.params["group_id"]);
    const parsed = groupChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    try {
      const payload = toNewGroupDeployChange(parsed.data);
      await deployService.changeDeployGroupInfo(payload);
      res.json({ ok: true });
    } catch (e: any) {
      createLogger({ groupId, error: e.message }).error("Change deploy group info failed");
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  return router;
}