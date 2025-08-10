import { Router } from "express";
import { QueryService } from "../services/query";
import { PrismaProjectService } from "../services/project";
import { IProjectService } from "../services/project";
import { GitLabApi } from "../gitlab";
import { z } from "zod";

const router = Router();
const queryService = new QueryService();
const projectService: IProjectService = new PrismaProjectService();
const gitlab = new GitLabApi();

router.get("/projects", async(_req, res) => {
  // Align default group id with your Rust default (e.g., 75 in server.rs)
  const groupId = Number(_req.query.group_id ?? 75);
  const projects = await queryService.getAllProjectsByGroupId(groupId);
  res.json(projects);
});

router.delete("/project/:id", async(req, res) => {
  const id = Number(req.params.id);
  const ok = await projectService.deleteProject(id);
  if (ok) return res.json({ ok: true });
  res.status(400).json({ ok: false });
});

router.post("/project/:id", async(req, res) => {
  const id = Number(req.params.id);
  const schema = z.object({ alias: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const ok = await projectService.updateProjectAlias(id, parsed.data.alias);
  if (ok) return res.json({ ok: true });
  res.status(400).json({ ok: false });
});
router.get("/projects/:id/branches", async (req, res) => {
    const schema = z.object({
    project_ids: z.array(z.number()),
    branch: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { project_ids, branch } = parsed.data;
  const filtered: number[] = [];
  try {
    for (const pid of project_ids) {
      const branches = await gitlab.queryBranchesInProject(pid, branch);
      if (!branch || branches.includes(branch)) filtered.push(pid);
    }
    res.json(filtered);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
// Fix search to use string[] from GitLabApi
router.post("/projects/search", async (req, res) => {
  const schema = z.object({
    project_ids: z.array(z.number()),
    branch: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { project_ids, branch } = parsed.data;
  const filtered: number[] = [];
  try {
    for (const pid of project_ids) {
      const branches = await gitlab.queryBranchesInProject(pid, branch);
      if (!branch || branches.includes(branch)) filtered.push(pid);
    }
    res.json(filtered);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});


export default router;