export interface IProjectService {
  deleteProject(id: number): Promise<boolean>;
  updateProjectAlias(id: number, alias: string): Promise<boolean>;
}
