import { db } from "../db";
import { NewFullDeploy } from "../models";
import { GitLabApi } from "../gitlab";
import { createLogger } from "../logger";

type DependType = "pre_build_all" | "pre_deploy_all" | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DeployService {

  async runDeploy(deployId: number, gitlabHost: string, token: string, scheme = "https") {
    createLogger({deployId}).info("Starting deploy run");
    const gitlab = new GitLabApi({ host: gitlabHost, token, scheme });

    // mark deploy running
    this.markDeployStart(deployId);

    // groups in order
    const groups = db
      .prepare("SELECT * FROM group_deploy_depend WHERE deploy_id = ? ORDER BY group_index ASC")
      .all(deployId) as Array<{
        id: number;
        deploy_id: number;
        group_index: number;
        depend_group_index: number;
        depend_type: string | null;
      }>;

    // run groups honoring dependencies
    for (const g of groups) {
      createLogger({ deployId, groupIndex: g.group_index }).info("Running group deploy");
      const dependType = (g.depend_type as DependType) ?? null;
      if (dependType) {
        const ok = await this.waitDependGroupOk(deployId, g.depend_group_index, dependType);
        if (!ok) {
          // mark failed and stop
          createLogger({ deployId, groupIndex: g.group_index }).error("Dependency group failed");
          db.prepare("UPDATE deploy_info SET status = ? WHERE id = ?").run("failed", deployId);
          return;
        }
      }
      // run all projects in this group (create tag/pipeline and seed jobs)
      const projects = db
        .prepare(
          "SELECT * FROM singe_project_deploy_info WHERE deploy_id = ? AND group_index = ? ORDER BY id ASC"
        )
        .all(deployId, g.group_index) as Array<{
          id: number;
          deploy_id: number;
          group_index: number;
          project_id: number;
          project_name: string;
          branch: string;
          tag_prefix: string;
          actual_tag: string | null;
          pipeline_id: number | null;
          status: string;
        }>;

      for (const p of projects) {
        try {
          createLogger({ deployId, projectId: p.project_id }).info("Starting project deploy");
          await this.runOneProject(gitlab, p);
        } catch (e) {
          // mark this project failed and entire deploy failed
          db.prepare(
            "UPDATE singe_project_deploy_info SET status = ? WHERE id = ?"
          ).run("failed", p.id);
          db.prepare("UPDATE deploy_info SET status = ? WHERE id = ?").run("failed", deployId);
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
        this.markDeployFailed(deployId);
        createLogger({ deployId }).error("Deploy failed");
        return;
      }
      if (outcome === "success") {
        this.markDeploySuccess(deployId);
        createLogger({ deployId }).info("Deploy succeeded");
        return;
      }
      await sleep(5000);
    }

    // timeout -> mark failed
    db.prepare("UPDATE deploy_info SET status = ? WHERE id = ?").run("failed", deployId);
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
    db.prepare(
      "UPDATE singe_project_deploy_info SET actual_tag = ?, pipeline_id = ?, status = ? WHERE id = ?"
    ).run(tag, pipelineId, "running", project.id);

    // insert pipeline_info if not present
    const exists = db
      .prepare("SELECT id FROM pipeline_info WHERE id = ?")
      .get(pipelineId) as { id?: number } | undefined;

    const detail = await gitlab.getDetailPipelineInfoById(project.project_id, pipelineId);
    if (!exists) {
      db.prepare(
        `INSERT INTO pipeline_info (id, deploy_id, project_id, status, user_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        pipelineId,
        project.deploy_id,
        project.project_id,
        detail.status,
        detail.user?.username ?? "",
        detail.created_at ?? "",
        detail.updated_at ?? ""
      );
    } else {
      db.prepare(
        `UPDATE pipeline_info SET status = ?, user_name = ?, created_at = ?, updated_at = ? WHERE id = ?`
      ).run(
        detail.status,
        detail.user?.username ?? "",
        detail.created_at ?? "",
        detail.updated_at ?? "",
        pipelineId
      );
    }

    // seed jobs
    const jobs = await gitlab.getJobsByPipeline(project.project_id, pipelineId);
    const insJob = db.prepare(
      `INSERT OR REPLACE INTO job
        (id, deploy_id, project_id, pipeline_id, name, stage, status, created_at, updated_at, web_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const j of jobs) {
      insJob.run(
        j.id,
        project.deploy_id,
        project.project_id,
        pipelineId,
        j.name ?? "",
        j.stage ?? "",
        j.status ?? "",
        j.created_at ?? "",
        j.finished_at ?? j.updated_at ?? "",
        j.web_url ?? ""
      );
    }
  }
  async retryFetch(deployId: number, host: string, token: string, scheme = "https") {
    const gitlab = new GitLabApi({ host, token, scheme });
    const outcome = await this.pollAndUpdateProjects(gitlab, deployId);
    if (outcome === "fail") {
      this.markDeployFailed(deployId);
      createLogger({ deployId }).error("Retry fetch failed");
    } else if (outcome === "success") {
      this.markDeploySuccess(deployId);
      createLogger({ deployId }).info("Retry fetch succeeded");
    }
    return { id: deployId, outcome };
  }

  private async pollAndUpdateProjects(gitlab: GitLabApi, deployId: number): Promise<"next" | "success" | "fail"> {
    createLogger({ deployId }).debug("Polling and updating projects");
    const projects = db
      .prepare(
        "SELECT * FROM singe_project_deploy_info WHERE deploy_id = ? ORDER BY id ASC"
      )
      .all(deployId) as Array<{
        id: number;
        project_id: number;
        pipeline_id: number | null;
        status: string;
      }>;

    let allSuccess = true;

    for (const p of projects) {
      if (!p.pipeline_id) {
        allSuccess = false;
        continue;
      }
      const detail = await gitlab.getDetailPipelineInfoById(p.project_id, p.pipeline_id);
      // update pipeline_info and project status
      db.prepare(
        "UPDATE pipeline_info SET status = ?, updated_at = ? WHERE id = ?"
      ).run(detail.status ?? "", detail.updated_at ?? "", p.pipeline_id);

      // update jobs snapshot
      const jobs = await gitlab.getJobsByPipeline(p.project_id, p.pipeline_id);
      const upsert = db.prepare(
        `INSERT OR REPLACE INTO job
          (id, deploy_id, project_id, pipeline_id, name, stage, status, created_at, updated_at, web_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const j of jobs) {
        upsert.run(
          j.id,
          deployId,
          p.project_id,
          p.pipeline_id,
          j.name ?? "",
          j.stage ?? "",
          j.status ?? "",
          j.created_at ?? "",
          j.finished_at ?? j.updated_at ?? "",
          j.web_url ?? ""
        );
      }

      const status = String(detail.status ?? "").toLowerCase();
      if (status === "success") {
        db.prepare("UPDATE singe_project_deploy_info SET status = ? WHERE id = ?").run("success", p.id);
      } else if (status === "failed" || status === "canceled") {
        db.prepare("UPDATE singe_project_deploy_info SET status = ? WHERE id = ?").run("failed", p.id);
        return "fail";
      } else {
        allSuccess = false;
        db.prepare("UPDATE singe_project_deploy_info SET status = ? WHERE id = ?").run("running", p.id);
      }
    }

    return allSuccess ? "success" : "next";
  }

  private async waitDependGroupOk(deployId: number, groupIndex: number, dependType: DependType): Promise<boolean> {
    const stageLike = dependType === "pre_build_all" ? "build" : "deploy";
    const maxRounds = 120;

    for (let round = 0; round < maxRounds; round++) {
      const projects = db
        .prepare(
          "SELECT project_id, pipeline_id FROM singe_project_deploy_info WHERE deploy_id = ? AND group_index = ?"
        )
        .all(deployId, groupIndex) as Array<{ project_id: number; pipeline_id: number | null }>;

      if (!projects.length) return true;

      // require every project in the depend group has pipeline and its jobs in stageLike are successful
      let allOk = true;
      for (const p of projects) {
        if (!p.pipeline_id) {
          allOk = false;
          break;
        }
        const rows = db
          .prepare(
            "SELECT status FROM job WHERE deploy_id = ? AND pipeline_id = ? AND stage LIKE ?"
          )
          .all(deployId, p.pipeline_id, `%${stageLike}%`) as Array<{ status: string }>;

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

  addFullDeploy(payload: NewFullDeploy): number {
    const run = db.transaction((p: NewFullDeploy) => {
      const body = JSON.stringify(p);
      const description = p.description ?? "";

      // 1) insert deploy_info
      const insertDeploy = db.prepare(
        "INSERT INTO deploy_info (status, body, description) VALUES (?, ?, ?)"
      );
      const deployRes = insertDeploy.run("pending", body, description);
      const deployId = Number(deployRes.lastInsertRowid);

      // 2) insert group_deploy_depend
      const insertGroup = db.prepare(
        "INSERT INTO group_deploy_depend (deploy_id, group_index, depend_group_index, depend_type) VALUES (?, ?, ?, ?)"
      );
      for (const g of p.groups || []) {
        insertGroup.run(
          deployId,
          g.group_index,
          g.depend_group_index ?? 0,
          g.depend_type ?? null
        );
      }

      // 3) insert singe_project_deploy_info
      const getProjectName = db.prepare(
        "SELECT name FROM project_info WHERE id = ?"
      );
      const insertProject = db.prepare(
        `INSERT INTO singe_project_deploy_info
          (deploy_id, group_index, project_id, project_name, branch, tag_prefix, actual_tag, pipeline_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const proj of p.projects || []) {
        const row = getProjectName.get(proj.project_id) as { name?: string } | undefined;
        const projectName =
          (row && row.name) ??
          // fallback to provided name if any (client may not send it)
          (proj as any).project_name ??
          "";

        insertProject.run(
          deployId,
          (proj as any).group_index, // group_index must exist in payload projects
          proj.project_id,
          projectName,
          proj.branch,
          proj.tag_prefix,
          null, // actual_tag
          null, // pipeline_id
          "pending"
        );
      }

      return deployId;
    });

    return run(payload);
  }

  copyDeployFromOld(fromId: number, description?: string): number {
    const run = db.transaction((fid: number, desc?: string) => {
      const oldDeploy = db
        .prepare("SELECT body, description FROM deploy_info WHERE id = ?")
        .get(fid) as { body?: string; description?: string } | undefined;
      if (!oldDeploy) throw new Error(`Deploy ${fid} not found`);

      const bodyStr = oldDeploy.body ?? "{}";
      const newDesc = desc ?? oldDeploy.description ?? "";

      // create new deploy_info
      const insertDeploy = db.prepare(
        "INSERT INTO deploy_info (status, body, description) VALUES (?, ?, ?)"
      );
      const deployRes = insertDeploy.run("pending", bodyStr, newDesc);
      const newDeployId = Number(deployRes.lastInsertRowid);

      // copy groups
      const selectGroups = db.prepare(
        "SELECT group_index, depend_group_index, depend_type FROM group_deploy_depend WHERE deploy_id = ? ORDER BY id ASC"
      );
      const groups = selectGroups.all(fid) as Array<{
        group_index: number;
        depend_group_index: number;
        depend_type: string | null;
      }>;
      const insertGroup = db.prepare(
        "INSERT INTO group_deploy_depend (deploy_id, group_index, depend_group_index, depend_type) VALUES (?, ?, ?, ?)"
      );
      for (const g of groups) {
        insertGroup.run(newDeployId, g.group_index, g.depend_group_index, g.depend_type);
      }

      // copy projects (reset runtime fields)
      const selectProjects = db.prepare(
        `SELECT group_index, project_id, project_name, branch, tag_prefix
         FROM singe_project_deploy_info
         WHERE deploy_id = ?
         ORDER BY id ASC`
      );
      const projects = selectProjects.all(fid) as Array<{
        group_index: number;
        project_id: number;
        project_name: string;
        branch: string;
        tag_prefix: string;
      }>;
      const insertProject = db.prepare(
        `INSERT INTO singe_project_deploy_info
          (deploy_id, group_index, project_id, project_name, branch, tag_prefix, actual_tag, pipeline_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const p of projects) {
        insertProject.run(
          newDeployId,
          p.group_index,
          p.project_id,
          p.project_name,
          p.branch,
          p.tag_prefix,
          null, // actual_tag
          null, // pipeline_id
          "pending"
        );
      }

      return newDeployId;
    });

    return run(fromId, description);
  }

  markDeployStart(deployId: number) {
    db.prepare("UPDATE deploy_info SET status = ? WHERE id = ?").run("running", deployId);
  }

  markDeploySuccess(deployId: number) {
    db.prepare("UPDATE deploy_info SET status = ? WHERE id = ?").run("success", deployId);
  }
  markDeployFailed(deployId: number) {
    db.prepare("UPDATE deploy_info SET status = ? WHERE id = ?").run("failed", deployId);
  }

  cancelDeploy(deployId: number) {
    db.prepare("UPDATE deploy_info SET status = ? WHERE id = ?").run("canceled", deployId);
  }
}