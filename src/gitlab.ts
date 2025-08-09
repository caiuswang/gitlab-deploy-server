import { request } from "undici";
import { createLogger } from "./logger";

import { GITLAB_HOST as CFG_HOST, GITLAB_SCHEME as CFG_SCHEME, GITLAB_TOKEN as CFG_TOKEN } from "./config";

export class GitLabApi {
  private host: string;
  private scheme: string;
  private token: string;

  constructor(opts?: { host?: string; token?: string; scheme?: string }) {
    this.host = opts?.host ?? CFG_HOST;
    this.scheme = opts?.scheme ?? CFG_SCHEME;
    this.token = opts?.token ?? CFG_TOKEN;
  }

  private baseUrl() {
    return `${this.scheme}://${this.host}/api/v4`;
  }


  private authHeaders() {
    // Send both to support PAT (PRIVATE-TOKEN) and OAuth/Group tokens (Bearer)
    return {
      // "PRIVATE-TOKEN": this.token,
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
  }

  private async handleJson(res: any) {
    const text = await res.body.text();
    try {
      return { json: JSON.parse(text), raw: text };
    } catch {
      return { json: null, raw: text };
    }
  }

  async queryBranchesInProject(projectId: number, search?: string): Promise<string[]> {
    const url = new URL(`${this.baseUrl()}/projects/${projectId}/repository/branches`);
    if (search) {
      url.searchParams.set("search", search);
    } else {
      url.searchParams.set("per_page", "100");
  }
    const res = await request(url, { headers: this.authHeaders() });
    if (res.statusCode >= 400) {
      const { raw } = await this.handleJson(res);
      throw new Error(`GitLab branches ${res.statusCode} ${url.toString()} :: ${raw}`);
    }
    const list = (await res.body.json()) as Array<{ name?: string }>;
    return list.map(b => b.name).filter((n): n is string => !!n);
  }

  async createTag(projectId: number, branch: string, tagPrefix: string) {
    // yyyyMMddHHmm in shanghai timezone
    const time_format = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Shanghai",
    });
    const tagName = `${tagPrefix}-${time_format.format(new Date()).replace(/\D/g, "").slice(0, 12)}`;
    createLogger({ projectId, branch, tagName }).info("Creating tag");
    const url = `${this.baseUrl()}/projects/${projectId}/repository/tags`;
    const res = await request(url, {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ tag_name: tagName, ref: branch }),
    });
    if (res.statusCode >= 400) {
      const { raw } = await this.handleJson(res);
      throw new Error(`GitLab create tag ${res.statusCode} ${url} :: ${raw}`);
    }
    return tagName;
  }

  async getPipelineIdByTag(projectId: number, tag: string): Promise<number> {
    const url = new URL(`${this.baseUrl()}/projects/${projectId}/pipelines`);
    url.searchParams.set("ref", tag);
    createLogger({ projectId, tag }).debug("Fetching pipeline ID by tag");
    const res = await request(url, { headers: this.authHeaders() });
    if (res.statusCode >= 400) {
      const { raw } = await this.handleJson(res);
      throw new Error(`GitLab pipelines ${res.statusCode} ${url.toString()} :: ${raw}`);
    }
    const list = (await res.body.json()) as any[];
    if (!list.length) {
      createLogger({ projectId, tag }).warn("No pipeline found for tag");
      throw new Error("No pipeline found for tag");
    }
    return list[0].id;
  }

  async getDetailPipelineInfoById(projectId: number, pipelineId: number) {
    const url = `${this.baseUrl()}/projects/${projectId}/pipelines/${pipelineId}`;
    createLogger({ projectId, pipelineId }).debug("Fetching pipeline detail");
    const res = await request(url, { headers: this.authHeaders() });
    if (res.statusCode >= 400) {
      const { raw } = await this.handleJson(res);
      createLogger({ projectId, pipelineId }).error(`GitLab pipeline ${res.statusCode} ${url} :: ${raw}`);
      throw new Error(`GitLab pipeline ${res.statusCode} ${url} :: ${raw}`);
    }
    createLogger({ projectId, pipelineId }).info("Fetched pipeline detail");
    return (await res.body.json()) as any;
  }

  async getJobsByPipeline(projectId: number, pipelineId: number) {
    const url = `${this.baseUrl()}/projects/${projectId}/pipelines/${pipelineId}/jobs`;
    createLogger({ projectId, pipelineId }).debug("Fetching jobs by pipeline");
    const res = await request(url, { headers: this.authHeaders() });
    if (res.statusCode >= 400) {
      const { raw } = await this.handleJson(res);
      createLogger({ projectId, pipelineId }).error(`GitLab jobs ${res.statusCode} ${url} :: ${raw}`);
      throw new Error(`GitLab jobs ${res.statusCode} ${url} :: ${raw}`);
    }
    return (await res.body.json()) as any[];
  }

}