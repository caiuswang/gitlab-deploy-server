import request from "supertest";
import { createApp } from "../src/app";
import { createServer } from "http";
import { BroadCastService, GitLabDeployService } from "../src/services/deploy";
import { WebSocketServer } from "ws";

let server: any;

beforeAll((done) => {
  const wss = new WebSocketServer({ noServer: true }); // Use `noServer` to manually handle WebSocket upgrades
  const gitlabService = new GitLabDeployService(new BroadCastService(wss))
  const app = createApp(gitlabService);
  server = createServer(app);
  server.listen(5555, done);
});

afterAll((done) => {
  server.close(done);
});

describe("HTTP API Tests", () => {
  test("GET /deploy should return a list of deploys", async () => {
    const response = await request(server).get("/");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("ok", true);
    expect(response.body).toHaveProperty("service", "ts-deploy-server");
  });

  test("GET /projects should return a list of projects", async () => {
    const response = await request(server).get("/projects");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  test("PUT /project should create a project", async() => {
    const reqJson = {
      project_id: 1,
      group_id: 1,
      project_name: "test-project",
      alias: "test-project-alias",
      path: "lucky/lotto-service/tl-lotto-api"
    }
    const response = await request(server)
      .put("/project")
      .send(reqJson);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("ok", true);
  })

  test("POST /project/:id should update a project alias", async () => {
    const projectId = 1; // Replace with a valid project ID
    const response = await request(server)
      .post(`/project/${projectId}`)
      .send({ alias: "test-alias-2" });
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("ok", true);
  });

  test("DELETE /project/:id should delete a project", async () => {
    const projectId = 1; // Replace with a valid project ID
    const response = await request(server).delete(`/project/${projectId}`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("ok", true);
  });

});
