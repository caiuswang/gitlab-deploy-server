import { Router } from "express";
import { QueryService } from "../services/query";
import { GitLabDeployService } from "../services/deploy";
import { IDeployService } from "../services/deploy";
import { GitLabApi } from "../gitlab";
import { NewFullDeploy } from "../models";
import { z } from "zod";
import { createLogger } from "../logger";

const router = Router();
const queryService = new QueryService();
const deployService: IDeployService = new GitLabDeployService();
const gitlab = new GitLabApi();

router.get("/", (_req, res) => {
  res.json({ ok: true, service: "ts-deploy-server" });
});

router.get("/deploys", async(_req, res) => {
  const list = await queryService.getAllDeployInfoPage(0, 50);
  res.json(list);
});

router.get("/deploy/:id", async(req, res) => {
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
    groups: input.groups.map(g => ({
      deploy_id: 0,
      group_index: g.group_index,
      depend_group_index: g.depend_group_index === 0 ? null : g.depend_group_index,
      depend_type: g.depend_type ?? null,
    })),
    projects: input.projects.map(p => ({
      deploy_id: 0,
      project_id: p.project_id,
      project_name: "",          // filled in service from project_info
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

  // run in background and respond immediately (similar to async orchestration)
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
    // result.outcome maps Rust RunOption: next->NEXT_CHECK, success->SUCCESS_STOP, fail->FAIL_STOP
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/deploy/copy", async(req, res) => {
  const { from_id, description } = req.body || {};
  if (typeof from_id !== "number") return res.status(400).json({ id: -1 });
  try {
    const id = await deployService.copyDeployFromOld(from_id, description);
    res.json({ id });
  } catch (e: any) {
    res.status(400).json({ id: -1, error: e.message });
  }
});

router.post("/deploy/re_deploy", (_req, res) => {
  res.status(501).json({ ok: false, message: "Not implemented yet" });
});

router.post("/deploy/cancel", async(_req, res) => {
  const deploy_id = Number(_req.body?.id);
  if (typeof deploy_id !== "number") return res.status(400).json({ id : -1 });
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


export default router;