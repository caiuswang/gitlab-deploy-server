import { NewFullDeploy } from "../models";
import { GitLabApi } from "../gitlab";
import { createLogger } from "../logger";
import { prisma } from "../db";

type DependType = "pre_build_all" | "pre_deploy_all" | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DeployService {

  async runDeploy(deployId: number, gitlabHost: string, token: string, scheme = "https") {
    createLogger({ deployId }).info("Starting deploy run");
    const gitlab = new GitLabApi({ host: gitlabHost, token, scheme });

    // mark deploy running
    await this.markDeployStart(deployId);

    // groups in order
    const groups = await prisma.group_deploy_depend.findMany({
      where: { deploy_id: deployId },
      orderBy: { group_index: "asc" }
    });

    // run groups honoring dependencies
    for (const g of groups) {
      createLogger({ deployId, groupIndex: g.group_index }).info("Running group deploy");
      const dependType = (g.depend_type as DependType) ?? null;
      if (dependType) {
        const ok = await this.waitDependGroupOk(deployId, g.depend_group_index, dependType);
        if (!ok) {
          // mark failed and stop
          createLogger({ deployId, groupIndex: g.group_index }).error("Dependency group failed");
          await prisma.deploy_info.update({
            where: { id: deployId },
            data: { status: "failed" }
          });
          return;
        }
      }
      // run all projects in this group (create tag/pipeline and seed jobs)
      const projects = await prisma.singe_project_deploy_info.findMany({
        where: { deploy_id: deployId, group_index: g.group_index },
        orderBy: { id: "asc" }
      });

      for (const p of projects) {
        try {
          createLogger({ deployId, projectId: p.project_id }).info("Starting project deploy");
          await this.runOneProject(gitlab, p);
        } catch (e) {
          // mark this project failed and entire deploy failed
          await prisma.singe_project_deploy_info.update({
            where: { id: p.id },
            data: { status: "failed" }
          });
          await this.markDeployFailed(deployId);
          return;
        }
      }
    }
    createLogger({ deployId }).info("Deploy polling started");
    // poll until success/fail like Rust continue_get_all_projects_info
    const maxRounds = 120; // ~10 minutes at 5s interval
    for (let round = 0; round < maxRounds; round++) {
      createLogger({ deployId, round }).debug("Deploy polling round");
      const outcome = await this.pollAndUpdateProjects(gitlab, deployId);
      if (outcome === "fail") {
        await this.markDeployFailed(deployId);
        createLogger({ deployId }).error("Deploy failed");
        return;
      }
      if (outcome === "success") {
        await this.markDeploySuccess(deployId);
        createLogger({ deployId }).info("Deploy succeeded");
        return;
      }
      await sleep(5000);
    }

    // timeout -> mark failed
    await this.markDeployFailed(deployId);
  }

  private async runOneProject(
    gitlab: GitLabApi,
    project: {
      id: number;
      deploy_id: number;
      project_id: number;
      branch: string;
      tag_prefix: string;
      pipeline_id: number | null;
      actual_tag: string | null;
    }
  ) {
    // create tag if not exists / not set
    let tag = project.actual_tag;
    if (!tag) {
      tag = await gitlab.createTag(project.project_id, project.branch, project.tag_prefix);
    }

    // iterate 5 times to avoid transient errors
    let pipelineId = -1;
    for (let attempt = 1; attempt <= 5; attempt++) {
      // get pipeline id by tag
      try {
        pipelineId = await gitlab.getPipelineIdByTag(project.project_id, tag);
        break; // success
      } catch (e: any) {
        if (attempt === 5) {
          createLogger({ projectId: project.project_id, tag, attempt }).error("Failed to get pipeline ID after 5 attempts");
          throw e; // rethrow on last attempt
        }
        // wait and retry
        await sleep(2000);
      }
    }
    // update project with tag + pipeline
    await prisma.singe_project_deploy_info.update({
      where: { id: project.id },
      data: {
        actual_tag: tag,
        pipeline_id: pipelineId,
        status: "running"
      }
    });

    const exists = await prisma.pipeline_info.findUnique({
      where: { id: pipelineId }
    });

    const detail = await gitlab.getDetailPipelineInfoById(project.project_id, pipelineId);
    if (!exists) {
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
      // db.prepare(
      //   `UPDATE pipeline_info SET status = ?, user_name = ?, created_at = ?, updated_at = ? WHERE id = ?`
      // ).run(
      //   detail.status,
      //   detail.user?.username ?? "",
      //   detail.created_at ?? "",
      //   detail.updated_at ?? "",
      //   pipelineId
      // );
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

    // seed jobs
    const jobs = await gitlab.getJobsByPipeline(project.project_id, pipelineId);

    for (const j of jobs) {
      await prisma.job.createMany({
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
  async retryFetch(deployId: number, host: string, token: string, scheme = "https") {
    const gitlab = new GitLabApi({ host, token, scheme });
    const outcome = await this.pollAndUpdateProjects(gitlab, deployId);
    if (outcome === "fail") {
      await this.markDeployFailed(deployId);
      createLogger({ deployId }).error("Retry fetch failed");
    } else if (outcome === "success") {
      await this.markDeploySuccess(deployId);
      createLogger({ deployId }).info("Retry fetch succeeded");
    }
    return { id: deployId, outcome };
  }

  private async pollAndUpdateProjects(gitlab: GitLabApi, deployId: number): Promise<"next" | "success" | "fail"> {
    createLogger({ deployId }).debug("Polling and updating projects");
    const projects = await prisma.singe_project_deploy_info.findMany({
      where: { deploy_id: deployId },
      orderBy: { id: "asc" }
    });

    let allSuccess = true;

    for (const p of projects) {
      if (!p.pipeline_id) {
        allSuccess = false;
        continue;
      }
      const detail = await gitlab.getDetailPipelineInfoById(p.project_id, p.pipeline_id);
      // update pipeline_info and project status
      await prisma.pipeline_info.update({
        where: { id: p.pipeline_id },
        data: {
          status: detail.status ?? "",
          updated_at: detail.updated_at ?? ""
        }
      });

      // update jobs snapshot
      const jobs = await gitlab.getJobsByPipeline(p.project_id, p.pipeline_id);
      for (const j of jobs) {
        await prisma.job.upsert({
          where: { id: j.id },
          update: {
            status: j.status ?? "",
            updated_at: j.finished_at ?? j.updated_at ?? "",
            web_url: j.web_url ?? ""
          },
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

        const status = String(detail.status ?? "").toLowerCase();
        if (status === "success") {
          await prisma.singe_project_deploy_info.update({
            where: { id: p.id },
            data: { status: "success" }
          });
        } else if (status === "failed" || status === "canceled") {
          await prisma.singe_project_deploy_info.update({
            where: { id: p.id },
            data: { status: "failed" }
          });
          return "fail";
        } else {
          allSuccess = false;
          await prisma.singe_project_deploy_info.update({
            where: { id: p.id },
            data: { status: "running" }
          });
        }
      }
    }

    return allSuccess ? "success" : "next";
  }

  private async waitDependGroupOk(deployId: number, groupIndex: number, dependType: DependType): Promise<boolean> {
    const stageLike = dependType === "pre_build_all" ? "build" : "deploy";
    const maxRounds = 120;

    for (let round = 0; round < maxRounds; round++) {
      const projects = await prisma.singe_project_deploy_info.findMany({
        where: { deploy_id: deployId, group_index: groupIndex },
        select: { project_id: true, pipeline_id: true }
      });

      if (!projects.length) return true;

      // require every project in the depend group has pipeline and its jobs in stageLike are successful
      let allOk = true;
      for (const p of projects) {
        if (!p.pipeline_id) {
          allOk = false;
          break;
        }

        const rows = await prisma.job.findMany({
          where: {
            deploy_id: deployId,
            pipeline_id: p.pipeline_id,
            stage: { contains: stageLike }
          },
          select: { status: true }
        });
        if (!rows.length) {
          allOk = false;
          break;
        }
        // if any failed/canceled -> fail immediately
        if (rows.some((r) => r.status === "failed" || r.status === "canceled")) {
          return false;
        }
        // if any not success -> keep waiting
        if (rows.some((r) => r.status !== "success")) {
          allOk = false;
          break;
        }
      }

      if (allOk) return true;
      await sleep(3000);
    }
    return false;
  }

  async addFullDeploy(payload: NewFullDeploy): Promise<number> {
    const deployId = await prisma.$transaction(async (tx) => {
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
        // lookup names
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
    return deployId;
  }
  // ...existing code...
  async copyDeployFromOld(fromId: number, description?: string): Promise<number> {
    const old = await prisma.deploy_info.findUnique({
      where: { id: fromId },
      select: { body: true, description: true }
    });
    if (!old) throw new Error(`Deploy ${fromId} not found`);
    const bodyStr = old.body ?? "{}";
    const newDesc = description ?? old.description ?? "";

    return prisma.$transaction(async tx => {
      // new deploy
      const newDeploy = await tx.deploy_info.create({
        data: { status: "pending", body: bodyStr, description: newDesc }
      });

      // copy groups
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

      // copy projects (reset runtime fields)
      const projects = await tx.singe_project_deploy_info.findMany({
        where: { deploy_id: fromId },
        select: {
          group_index: true,
          project_id: true,
          project_name: true,
          branch: true,
          tag_prefix: true
        }
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
    await prisma.deploy_info.update({
      where: { id: deployId },
      data: { status: "running" }
    });
  }

  async markDeploySuccess(deployId: number) {
    await prisma.deploy_info.update({
      where: { id: deployId },
      data: { status: "success" }
    });
  }
  async markDeployFailed(deployId: number) {
    await prisma.deploy_info.update({
      where: { id: deployId },
      data: { status: "failed" }
    });
  }

  async cancelDeploy(deployId: number) {
    await prisma.deploy_info.update({
      where: { id: deployId },
      data: { status: "canceled" }
    });
    createLogger({ deployId }).info("Deploy canceled");
  }
}