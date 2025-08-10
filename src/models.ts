// Loose TS models to match Diesel schema in your Rust code.
// See Rust models in `src/api/models.rs`.
export interface DeployInfo {
  id: number;
  status?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectInfo {
  id: number;
  project_id: number;
  group_id?: number;
  project_name?: string;
  alias?: string;
  branch?: string;
  tag_prefix?: string;
}

export interface SingleProjectDeployInfo {
  id: number;
  deploy_id: number;
  project_id: number;
  project_name: string;
  branch: string;
  tag_prefix: string;
  pipeline_id?: number | null;
}

export interface GroupDeployDepend {
  id: number;
  deploy_id: number;
  group_index: number;
  depend_group_index?: number | null;
  depend_type?: string | null;
}

export interface PipelineInfo {
  id: number;
  deploy_id: number;
  project_id: number;
  pipeline_id: number;
  status?: string;
  user_name?: string;
  created_at?: string;
  updated_at?: string;
}

// Payloads (see `NewFullDeploy` in Rust)
export interface NewGroupDeployDepend {
  deploy_id: number;
  group_index: number;
  depend_group_index?: number | null;
  depend_type?: string | null;
}

export interface NewSingleProjectDeployInfo {
  deploy_id: number;
  project_id: number;
  project_name: string;
  branch: string;
  tag_prefix: string;
  pipeline_id?: number | null;
}

export interface NewFullDeploy {
  description?: string;
  groups: NewGroupDeployDepend[];
  projects: NewSingleProjectDeployInfo[];
}
export interface GroupDeployChange {
  deploy_id: number;
  group_id?: number | null;
  group_index: number;
  depend_group_index?: number | null;
  depend_type?: string | null;
  description?: string;
  projects: NewSingleProjectDeployInfo[];
}