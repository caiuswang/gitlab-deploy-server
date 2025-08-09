import { db } from "../db";
import { DeployInfo, ProjectInfo } from "../models";

export class QueryService {
  getAllDeployInfoPage(offset = 0, limit = 50): DeployInfo[] {
    const stmt = db.prepare(
      "SELECT * FROM deploy_info ORDER BY id DESC LIMIT ? OFFSET ?"
    );
    return stmt.all(limit, offset) as DeployInfo[];
  }

  getDeployInfo(id: number): DeployInfo | undefined {
    const stmt = db.prepare("SELECT * FROM deploy_info WHERE id = ?");
    return stmt.get(id) as DeployInfo | undefined;
  }

  getDeployDetail(deployId: number) {
    const deploy = db
      .prepare("SELECT * FROM deploy_info WHERE id = ?")
      .get(deployId) as any | undefined;
    if (!deploy) return undefined;

    const groups = db
      .prepare(
        "SELECT * FROM group_deploy_depend WHERE deploy_id = ? ORDER BY group_index ASC, id ASC"
      )
      .all(deployId) as any[];

    const projects = db
      .prepare(
        "SELECT * FROM singe_project_deploy_info WHERE deploy_id = ? ORDER BY group_index ASC, id ASC"
      )
      .all(deployId) as any[];

    const pipelines = db
      .prepare(
        "SELECT * FROM pipeline_info WHERE deploy_id = ? ORDER BY id ASC"
      )
      .all(deployId) as any[];

    let jobs: any[] = [];
    try {
      jobs = db
        .prepare("SELECT * FROM job WHERE deploy_id = ? ORDER BY id ASC")
        .all(deployId) as any[];
    } catch {
      jobs = [];
    }

    const groupsDetailed = groups.map((g) => ({
      ...g,
      projects: projects.filter((p) => p.group_index === g.group_index),
    }));

    return {
      deploy,
      groups,
      projects,
      pipelines,
      jobs,
      groupsDetailed,
    };
  }

  getAllProjectsByGroupId(groupId: number): ProjectInfo[] {
    // If `group_id` column differs, adjust query accordingly.
    const stmt = db.prepare(
      "SELECT * FROM project_info WHERE group_id = ? ORDER BY id ASC"
    );
    return stmt.all(groupId) as ProjectInfo[];
  }
}