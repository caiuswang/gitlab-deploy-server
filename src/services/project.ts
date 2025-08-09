import { db, prisma } from "../db";

export class ProjectService {
  async deleteProject(id: number): Promise<boolean> {
    const info = await prisma.project_info.delete({
      where: { id },
    });
    return info ? true : false;
  }

  async updateProjectAlias(id: number, alias: string): Promise<boolean> {
    // If alias column differs, adjust.
    const info = await prisma.project_info.update({
      where: { id },
      data: { alias },
    });
    return info ? true : false;
  }
}