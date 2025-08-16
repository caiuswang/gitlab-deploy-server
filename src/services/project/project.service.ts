import { prisma } from "../../db";
import { IProjectService } from "./project.interface";
import { createLogger } from "../../logger";

export class PrismaProjectService implements IProjectService {
  async insertProject(project_id: number, project_name: string, group_id: number, path: string): Promise<void> {
    createLogger({ project_id: project_id, project_name: project_name })
      .info("Inserting project")
    await prisma.project_info.create(
      {
        data: {
          id: project_id,
          group_id: group_id,
          name: project_name,
          alias: project_name,
          full_path: path,
        }
      }
    )
  }
  private log(ctx: Record<string, any>) { return createLogger({ service: "ProjectService", ...ctx }); }

  async deleteProject(id: number): Promise<boolean> {
    this.log({ id }).info("Deleting project");
    const info = await prisma.project_info.delete({ where: { id } });
    return !!info;
  }

  async updateProjectAlias(id: number, alias: string): Promise<boolean> {
    this.log({ id }).info("Updating project alias");
    const info = await prisma.project_info.update({ where: { id }, data: { alias } });
    return !!info;
  }
}
