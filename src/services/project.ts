import { db } from "../db";

export class ProjectService {
  deleteProject(id: number): boolean {
    const stmt = db.prepare("DELETE FROM project_info WHERE id = ?");
    const info = stmt.run(id);
    return info.changes > 0;
  }

  updateProjectAlias(id: number, alias: string): boolean {
    // If alias column differs, adjust.
    const stmt = db.prepare("UPDATE project_info SET alias = ? WHERE id = ?");
    const info = stmt.run(alias, id);
    return info.changes > 0;
  }
}