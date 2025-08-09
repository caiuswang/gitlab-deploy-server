import { db, prisma } from "../db";
import { DeployInfo, ProjectInfo } from "../models";

export class QueryService {
  async getAllDeployInfoPage(offset = 0, limit = 50): Promise<DeployInfo[]> {
    const deploys = await prisma.deploy_info.findMany({
      orderBy: { id: "desc" },
      skip: offset,
      take: limit,
    });
    return deploys as DeployInfo[];
  }

  async getDeployInfo(id: number): Promise<DeployInfo | null> {
    return prisma.deploy_info.findUnique({
      where: { id },
    }) as Promise<DeployInfo | null>;
  }

  async getDeployDetail(deployId: number) : Promise<{
    id: number;
    status: string;
    description?: string;
    deploy: DeployInfo;
    groups: any[];
    projects: any[];
    pipelines: any[];
    jobs: any[];
    groupsDetailed: any[];
  } | undefined> {
    const deploy = await prisma.deploy_info.findUnique({
      where: { id: deployId },
    });
    if (!deploy) return undefined;

    const groups = await prisma.group_deploy_depend.findMany({
      where: { deploy_id: deployId },
      orderBy: [{ group_index: "asc"}, {id: "asc" }],
    });
    const projects = await prisma.singe_project_deploy_info.findMany({
      where: { deploy_id: deployId },
      orderBy: [{ group_index: "asc"}, {id: "asc" }],
    });

    const pipelines = await prisma.pipeline_info.findMany({
      where: { deploy_id: deployId },
      orderBy: { id: "asc" },
    });

    const jobs = await prisma.job.findMany({
      where: { deploy_id: deployId },
      orderBy: { id: "asc" },
    });

    const groupsDetailed = groups.map((g) => ({
      ...g,
      projects: projects.filter((p) => p.group_index === g.group_index),
    }));

    return {
      id: deploy.id,
      status: deploy.status,
      description: deploy.description,
      deploy,
      groups,
      projects,
      pipelines,
      jobs,
      groupsDetailed,
    };
  }

  async getAllProjectsByGroupId(groupId: number): Promise<ProjectInfo[]> {
    const projects = await prisma.project_info.findMany({
      where: { group_id: groupId },
      orderBy: { id: "asc" },
    });
    // Map database result to ProjectInfo interface
    return projects.map((p) => ( {
      id: p.id,
      project_id: p.id, // or use p.project_id if available in DB
      group_id: p.group_id,
      project_name: p.name,
      alias: p.alias,
      name: p.name,
      full_path: p.full_path,
      path: p.full_path,
      // Add other fields if available in p
    }));
  }
}