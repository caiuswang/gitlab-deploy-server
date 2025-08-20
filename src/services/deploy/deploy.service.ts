import { GroupDeployChange, NewFullDeploy, SingleProjectDeployInfo } from "../../models";
import { GitLabApi } from "../../gitlab";
import { createLogger } from "../../logger";
import { prisma } from "../../db";
import { SERVER_PORT } from "../../config"
import {
  MAX_POLL_ROUNDS,
  POLL_INTERVAL_MS,
  PIPELINE_RETRY_ATTEMPTS,
  PIPELINE_RETRY_DELAY_MS,
  MAX_DEPEND_ROUNDS,
  WAIT_DEPEND_INTERVAL_MS
} from "./deploy.constants";
import { IDeployService, GroupDependType, IBroadCast} from "./deploy.interface";
import { WebSocketServer } from "ws";
import { job } from "../../generated/prisma";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitLabDeployService implements IDeployService {
  broadCastService : IBroadCast;

  constructor(broadcast : IBroadCast) {
    this.broadCastService = broadcast;
  }
  async changeDeployGroupInfo(payload: GroupDeployChange): Promise<void> {
    const { deploy_id, group_id, group_index, depend_group_index, depend_type, projects, description } = payload;
    if (description != null) {
      await prisma.deploy_info.update({ where: { id: deploy_id }, data: { description } });
      createLogger({ deploy_id, description }).info("Updated deploy description");
    }
    let newProjects: any[] = [];
    let updatedProjects: SingleProjectDeployInfo[] = [];
    let removedProjects: SingleProjectDeployInfo[] = [];
    if (projects && projects.length) {
      const projectIds = projects.map(p => p.project_id);
      const existingProjects = await prisma.singe_project_deploy_info.findMany({
        where: { deploy_id: deploy_id }
      });
      for (const p of existingProjects) {
        if (projectIds.includes(p.project_id)) {
          updatedProjects.push(p);
        } else {
          removedProjects.push(p);
        }
      }
      newProjects = projects.filter(p => !existingProjects.some(ep => ep.project_id === p.project_id));
    } else {
      removedProjects = await prisma.singe_project_deploy_info.findMany({
        where: { deploy_id: deploy_id, group_index: group_index }
      });
    }
    if (!group_id) {
      const existGroup = await prisma.group_deploy_depend.findFirst({
        where: { deploy_id: deploy_id, group_index: group_index }
      });
      if (existGroup) {
        throw new Error(`Group with index ${group_index} already exists for deploy ${deploy_id}`);
      }
    }
    await prisma.$transaction(async (tx) => {
      if (!group_id) {
        const newGroup = await tx.group_deploy_depend.create({
          data: {
            deploy_id: deploy_id,
            group_index: group_index,
            depend_group_index: depend_group_index ?? 0,
            depend_type: depend_type ?? null
          }
        });
        createLogger({ group_index, depend_group_index, depend_type }).info("Created new group deploy dependency");
      } else {
        await tx.group_deploy_depend.update({
          where: { id: group_id },
          data: {
            group_index: group_index,
            depend_group_index: depend_group_index ?? 0,
            depend_type: depend_type ?? null
          }
        });
      }
      if (newProjects.length) {
        await tx.singe_project_deploy_info.createMany({
          data: newProjects.map(p => ({
            deploy_id: deploy_id,
            group_index: group_index,
            project_id: p.project_id,
            project_name: p.project_name,
            branch: p.branch,
            tag_prefix: p.tag_prefix,
            actual_tag: null,
            pipeline_id: null,
            status: "pending"
          }))
        });
      }
      if (updatedProjects.length) {
        for (const p of updatedProjects) {
          await tx.singe_project_deploy_info.update({
            where: { id: p.id },
            data: {
              group_index: group_index,
              branch: projects.find(pr => pr.project_id === p.project_id)?.branch ?? "",
              tag_prefix: projects.find(pr => pr.project_id === p.project_id)?.tag_prefix ?? ""
            }
          });
        }
      }
      if (removedProjects.length) {
        const removeIds = removedProjects.map(p => p.id);
        await tx.singe_project_deploy_info.deleteMany({
          where: { id: { in: removeIds } }
        });
      }
    }, { maxWait: 100000 });
  }
  private log(ctx: Record<string, any>) { return createLogger(ctx); }

  async runDeploy(deployId: number, gitlabHost: string, token: string, scheme = "https") {
    this.log({ deployId }).info("Starting deploy run");
    const gitlab = new GitLabApi({ host: gitlabHost, token, scheme });
    await this.markDeployStart(deployId);
    const groups = await prisma.group_deploy_depend.findMany({
      where: { deploy_id: deployId },
      orderBy: { group_index: "asc" }
    });
    for (const g of groups) {
      this.log({ deployId, groupIndex: g.group_index }).info("Running group deploy");
      const groupDependType: GroupDependType = g.depend_type as GroupDependType ?? null;
      if (groupDependType) {
        const ok = await this.waitDependGroupOk(deployId, g.depend_group_index, groupDependType);
        if (!ok) {
          this.log({ deployId, groupIndex: g.group_index }).error("Dependency group failed");
          await prisma.deploy_info.update({ where: { id: deployId }, data: { status: "failed" } });
          return;
        }
      }
      const projects = await prisma.singe_project_deploy_info.findMany({
        where: { deploy_id: deployId, group_index: g.group_index },
        orderBy: { id: "asc" }
      });
      let startPolling = false;
      for (const p of projects) {
        try {
          this.log({ deployId, projectId: p.project_id }).info("Starting project deploy");
          await this.runOneProject(gitlab, p);
          if (!startPolling) {
            startPolling = true;
            (async () => {
              this.log({ deployId }).info("Deploy polling started");
              for (let round = 0; round < MAX_POLL_ROUNDS; round++) {
                this.log({ deployId, round }).debug("Deploy polling round");
                const outcome = await this.pollAndUpdateProjects(gitlab, deployId);
                if (outcome === "fail") { await this.markDeployFailed(deployId); this.log({ deployId }).error("Deploy failed"); return; }
                if (outcome === "success") { await this.markDeploySuccess(deployId); this.log({ deployId }).info("Deploy succeeded"); return; }
                await sleep(POLL_INTERVAL_MS);
              }
            })();
          }
        } catch (e) {
          this.log({ deployId, projectId: p.project_id, error: (e as Error).message }).error("Project deploy failed");
          await prisma.singe_project_deploy_info.update({ where: { id: p.id }, data: { status: "failed" } });
          await this.markDeployFailed(deployId);
          return;
        }
      }
    }
  }

  private async runOneProject(
    gitlab: GitLabApi,
    project: { id: number; deploy_id: number; project_id: number; branch: string; tag_prefix: string; pipeline_id: number | null; actual_tag: string | null; }
  ) {
    let tag = project.actual_tag || await gitlab.createTag(project.project_id, project.branch, project.tag_prefix);
    let pipelineId = -1;
    for (let attempt = 1; attempt <= PIPELINE_RETRY_ATTEMPTS; attempt++) {
      try { pipelineId = await gitlab.getPipelineIdByTag(project.project_id, tag); break; }
      catch (e) {
        if (attempt === PIPELINE_RETRY_ATTEMPTS) { this.log({ projectId: project.project_id, tag, attempt }).error("Failed to get pipeline ID after retries"); throw e; }
        await sleep(PIPELINE_RETRY_DELAY_MS);
      }
    }
    await prisma.singe_project_deploy_info.update({ where: { id: project.id }, data: { actual_tag: tag, pipeline_id: pipelineId, status: "running" } });
    const detail = await gitlab.getDetailPipelineInfoById(project.project_id, pipelineId);
    const existingPipeline = await prisma.pipeline_info.findUnique({ where: { id: pipelineId } });
    if (!existingPipeline) {
      await prisma.pipeline_info.create({
        data: {
          id: pipelineId,
          deploy_id: project.deploy_id,
          project_id: project.project_id,
          status: detail.status ?? "",
          user_name: detail.user?.username ?? "",
          created_at: detail.created_at ?? "",
          updated_at: detail.updated_at ?? ""
        }
      });
    } else {
      await prisma.pipeline_info.update({
        where: { id: pipelineId },
        data: {
          status: detail.status ?? "",
          user_name: detail.user?.username ?? "",
          created_at: detail.created_at ?? "",
          updated_at: detail.updated_at ?? ""
        }
      });
    }
    const jobs = await gitlab.getJobsByPipeline(project.project_id, pipelineId);
    for (const j of jobs) {
      const existingJob = await prisma.job.findUnique({ where: { id: j.id } });
      if (existingJob) {
        await prisma.job.update({
          where: { id: j.id },
          data: {
            deploy_id: project.deploy_id,
            project_id: project.project_id,
            pipeline_id: pipelineId,
            name: j.name ?? "",
            stage: j.stage ?? "",
            status: j.status ?? "",
            created_at: j.created_at ?? "",
            updated_at: j.finished_at ?? j.updated_at ?? "",
            web_url: j.web_url ?? ""
          }
        });
      } else {
        await prisma.job.create({
          data: {
            id: j.id,
            deploy_id: project.deploy_id,
            project_id: project.project_id,
            pipeline_id: pipelineId,
            name: j.name ?? "",
            stage: j.stage ?? "",
            status: j.status ?? "",
            created_at: j.created_at ?? "",
            updated_at: j.finished_at ?? j.updated_at ?? "",
            web_url: j.web_url ?? ""
          }
        });
      }
    }
  }

  async retryFetch(deployId: number, host: string, token: string, scheme = "https") {
    const gitlab = new GitLabApi({ host, token, scheme });
    const outcome = await this.pollAndUpdateProjects(gitlab, deployId);
    if (outcome === "fail") { await this.markDeployFailed(deployId); this.log({ deployId }).error("Retry fetch failed"); }
    else if (outcome === "success") { await this.markDeploySuccess(deployId); this.log({ deployId }).info("Retry fetch succeeded"); }
    return { id: deployId, outcome };
  }

  private async pollAndUpdateProjects(gitlab: GitLabApi, deployId: number): Promise<"next" | "success" | "fail"> {
    this.log({ deployId }).debug("Polling and updating projects");
    const projects = await prisma.singe_project_deploy_info.findMany({ where: { deploy_id: deployId }, orderBy: { id: "asc" } });
    let allSuccess = true;
    for (const p of projects) {
      if (!p.pipeline_id) { allSuccess = false; continue; }
      const detail = await gitlab.getDetailPipelineInfoById(p.project_id, p.pipeline_id);
      await prisma.pipeline_info.update({ where: { id: p.pipeline_id }, data: { status: detail.status ?? "", updated_at: detail.updated_at ?? "" } });
      const jobs = await gitlab.getJobsByPipeline(p.project_id, p.pipeline_id);
      for (const j of jobs) {
        await prisma.job.upsert({
          where: { id: j.id },
            update: { status: j.status ?? "", updated_at: j.finished_at ?? j.updated_at ?? "", web_url: j.web_url ?? "" },
            create: {
              id: j.id,
              deploy_id: deployId,
              project_id: p.project_id,
              pipeline_id: p.pipeline_id,
              name: j.name ?? "",
              stage: j.stage ?? "",
              status: j.status ?? "",
              created_at: j.created_at ?? "",
              updated_at: j.finished_at ?? j.updated_at ?? "",
              web_url: j.web_url ?? ""
            }
        });
      }
      const status = String(detail.status ?? "").toLowerCase();
      if (status === "success") {
        await prisma.singe_project_deploy_info.update({ where: { id: p.id }, data: { status: "success" } });
      } else if (status === "failed" || status === "canceled") {
        await prisma.singe_project_deploy_info.update({ where: { id: p.id }, data: { status: "failed" } });
        return "fail";
      } else {
        allSuccess = false;
        await prisma.singe_project_deploy_info.update({ where: { id: p.id }, data: { status: "running" } });
      }
    }
    return allSuccess ? "success" : "next";
  }

  private async waitDependGroupOk(deployId: number, groupIndex: number, dependType: GroupDependType): Promise<boolean> {
    const stageLike = dependType === "pre_build_all" ? "build" : "deploy";
    for (let round = 0; round < MAX_DEPEND_ROUNDS; round++) {
      const projects = await prisma.singe_project_deploy_info.findMany({
        where: { deploy_id: deployId, group_index: groupIndex },
        select: { project_id: true, pipeline_id: true }
      });
      if (!projects.length) return true;
      let allOk = true;
      for (const p of projects) {
        if (!p.pipeline_id) { allOk = false; break; }
        const jobs = await<Promise<Array<job>>> prisma.job.findMany({
          where: { deploy_id: deployId, pipeline_id: p.pipeline_id, stage: { contains: stageLike } },
          select: { id: true, status: true, name: true }
        });
        let named_group_jobs : Map<string, job> = new Map();
        for (const job of jobs) {
          if (!named_group_jobs.has(job.name)) {
            named_group_jobs.set(job.name, job);
          } else {
            const existJob = named_group_jobs.get(job.name);
            if (existJob!.id < job.id) {
              named_group_jobs.set(job.name, job);
            }
          }
        }
        if (named_group_jobs.size == 0) { allOk = false; break;}
        for (let job of named_group_jobs.values()) {
          if (job.status === "failed" || job.status === "canceled") return false;
          if (job.status !== "success") { allOk = false; break; }
        }
      }
      if (allOk) return true;
      await sleep(WAIT_DEPEND_INTERVAL_MS);
    }
    return false;
  }

  async addFullDeploy(payload: NewFullDeploy): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const deploy = await tx.deploy_info.create({
        data: { status: "pending", body: JSON.stringify(payload), description: payload.description ?? "" }
      });
      if (payload.groups?.length) {
        await tx.group_deploy_depend.createMany({
          data: payload.groups.map(g => ({
            deploy_id: deploy.id,
            group_index: g.group_index,
            depend_group_index: g.depend_group_index ?? 0,
            depend_type: g.depend_type ?? null
          }))
        });
      }
      if (payload.projects?.length) {
        const projectIds = [...new Set(payload.projects.map(p => p.project_id))];
        const names = await tx.project_info.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } });
        const nameMap = Object.fromEntries(names.map(n => [n.id, n.name]));
        await tx.singe_project_deploy_info.createMany({
          data: payload.projects.map(p => ({
            deploy_id: deploy.id,
            group_index: (p as any).group_index,
            project_id: p.project_id,
            project_name: nameMap[p.project_id] ?? (p as any).project_name ?? "",
            branch: p.branch,
            tag_prefix: p.tag_prefix,
            actual_tag: null,
            pipeline_id: null,
            status: "pending"
          }))
        });
      }
      return deploy.id;
    });
  }

  async copyDeployFromOld(fromId: number, description?: string): Promise<number> {
    return prisma.$transaction(async tx => {
      const old = await prisma.deploy_info.findUnique({
        where: { id: fromId },
        select: { body: true, description: true }
      });
      if (!old) throw new Error(`Deploy ${fromId} not found`);
      const bodyStr = old.body ?? "{}";
      const newDesc = description ?? old.description ?? "";
      const newDeploy = await tx.deploy_info.create({
        data: { status: "pending", body: bodyStr, description: newDesc }
      });
      const groups = await tx.group_deploy_depend.findMany({
        where: { deploy_id: fromId },
        select: { group_index: true, depend_group_index: true, depend_type: true }
      });
      if (groups.length) {
        await tx.group_deploy_depend.createMany({
          data: groups.map(g => ({
            deploy_id: newDeploy.id,
            group_index: g.group_index,
            depend_group_index: g.depend_group_index,
            depend_type: g.depend_type
          }))
        });
      }
      const projects = await tx.singe_project_deploy_info.findMany({
        where: { deploy_id: fromId },
        select: { group_index: true, project_id: true, project_name: true, branch: true, tag_prefix: true }
      });
      if (projects.length) {
        await tx.singe_project_deploy_info.createMany({
          data: projects.map(p => ({
            deploy_id: newDeploy.id,
            group_index: p.group_index,
            project_id: p.project_id,
            project_name: p.project_name,
            branch: p.branch,
            tag_prefix: p.tag_prefix,
            actual_tag: null,
            pipeline_id: null,
            status: "pending"
          }))
        });
      }
      return newDeploy.id;
    });
  }

  async markDeployStart(deployId: number) { 
      await prisma.deploy_info.update({ where: { id: deployId }, data: { status: "running" } }); 
      createLogger({id: deployId}).info("update status to running")
  }
  async markDeploySuccess(deployId: number) { 
      await prisma.deploy_info.update({ where: { id: deployId }, data: { status: "success" } }); 
  }
  async markDeployFailed(deployId: number) { 
      await prisma.deploy_info.update({ where: { id: deployId}, data: {status: "failed"} }); 
  }
  async cancelDeploy(deployId: number) {
      await prisma.deploy_info.update({ where: { id: deployId }, data: { status: "canceled" } });
      await prisma.singe_project_deploy_info.updateMany({ where: { deploy_id: deployId }, data: { status: "canceled" } });
  }
}

export class BroadCastService implements IBroadCast {

  wss: WebSocketServer;

  constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  broadcastDeployUpdate(deployId: number, event: any) {
    const message = JSON.stringify(event);
    this.wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        const url = new URL(client.url || "", `http://localhost:${SERVER_PORT}`);
        const endpoint = url.pathname;
        if (endpoint === `/ws/deploy/${deployId}`) {
          client.send(message);
        }
      }
    });
  }
}
