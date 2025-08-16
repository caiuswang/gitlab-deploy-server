import { GroupDeployChange, NewFullDeploy } from "../../models";

export type GroupDependType = "pre_build_all" | "pre_deploy_all" | null;

export interface IDeployService {
  runDeploy(deployId: number, gitlabHost: string, token: string, scheme?: string): Promise<void>;
  retryFetch(deployId: number, host: string, token: string, scheme?: string): Promise<{ id: number; outcome: "next" | "success" | "fail" }>;
  addFullDeploy(payload: NewFullDeploy): Promise<number>;
  changeDeployGroupInfo(payload: GroupDeployChange): Promise<void>;
  copyDeployFromOld(fromId: number, description?: string): Promise<number>;
  cancelDeploy(deployId: number): Promise<void>;
}
export interface IBroadCast {
// Broadcast function for deploy updates
  broadcastDeployUpdate(deployId: number, event: any) : void;
}
