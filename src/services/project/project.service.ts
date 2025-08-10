import { prisma } from "../../db";
import { IProjectService } from "./project.interface";
import { createLogger } from "../../logger";

export class PrismaProjectService implements IProjectService {
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
