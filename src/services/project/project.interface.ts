export interface IProjectService {
  insertProject(project_id: number, project_name: string, group_id : number, path: string) : Promise<void>;
  deleteProject(id: number): Promise<boolean>;
  updateProjectAlias(id: number, alias: string): Promise<boolean>;
}
