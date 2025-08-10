import request from "supertest";
import { createApp } from "../src/app";
import { createServer } from "http";

let server: ReturnType<typeof createServer>;

beforeAll(() => {
  const app = createApp();
  server = createServer(app);
});

afterAll((done) => {
  server.close(done);
});

describe("HTTP API Tests", () => {
  test("GET /api/deploy should return a list of deploys", async () => {
    const response = await request(server).get("/api/deploy");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("ok", true);
    expect(response.body).toHaveProperty("service", "ts-deploy-server");
  });

  test("GET /api/project/projects should return a list of projects", async () => {
    const response = await request(server).get("/api/project/projects");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  test("DELETE /api/project/:id should delete a project", async () => {
    const projectId = 1; // Replace with a valid project ID
    const response = await request(server).delete(`/api/project/${projectId}`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("ok", true);
  });

  test("POST /api/project/:id should update a project alias", async () => {
    const projectId = 1; // Replace with a valid project ID
    const response = await request(server)
      .post(`/api/project/${projectId}`)
      .send({ alias: "new-alias" });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("ok", true);
  });

  test("POST /api/project/projects/search should filter projects by branch", async () => {
    const response = await request(server)
      .post("/api/project/projects/search")
      .send({ project_ids: [1, 2, 3], branch: "main" });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});
