# gitlab group deploy management backend

## Setup
1. `cp .env.example .env` and fill in the environment variables.
2. `npm install` to install dependencies.
3. `npm run build` to build the project.
4. `npm run dev` to start the development server.

### Environment Variables
- `PORT`: The port the server will run on (default: 3000).
- `DATABASE_URL`: The database connection string for Prisma.
- `GITLAB_SCHEME`: The scheme for GitLab API (default: https).
- `GITLAB_TOKEN`: Your GitLab personal access token.
- `GITLAB_HOSt`: The base URL for the GitLab API (default:
#### Example
```md
SERVER_PORT=3000
# If relative, it is resolved to repo root (../.. from dist). Default uses repo database.db
DATABASE_URL=file:../../database.db
# GitLab access
GITLAB_SCHEME=https
GITLAB_HOST=gitlab.xxx.com
GITLAB_TOKEN=xxxx

```

### Prisma setup
1. `npx prisma generate`
2. `npx prisma db push` to create the database schema.
3. (Optional) `npx prisma studio` to open the database admin UI.

## API Endpoints

### Deploys

#### GET /deploys
- List deploys (first 50).

#### GET /deploy/:id
- Get details for a specific deploy.

#### POST /deploy/create
- Create a new deploy.
- Request body:  
  ```json
  {
    "description": "string (optional)",
    "groups": [
      {
        "group_index": number,
        "depend_group_index": number,
        "depend_type": "string (optional or null)"
      }
    ],
    "projects": [
      {
        "group_index": number,
        "project_id": number,
        "branch": "string",
        "tag_prefix": "string",
        "actual_tag": "string (optional or null)",
        "pipeline_id": number (optional or null)
      }
    ]
  }
  ```

#### POST /deploy/run
- Start a deploy (runs in background).
- Request body:
  ```json
  {
    "id": number,
    "host": "string",
    "token": "string",
    "scheme": "string (optional, default: https)"
  }
  ```

#### POST /deploy/retry
- Retry fetching deploy status.
- Request body: same as `/deploy/run`.

#### POST /deploy/copy
- Copy an existing deploy.
- Request body:
  ```json
  {
    "from_id": number,
    "description": "string (optional)"
  }
  ```

#### POST /deploy/re_deploy
- Not implemented yet.

#### POST /deploy/cancel
- Cancel a deploy.
- Request body:
  ```json
  {
    "id": number
  }
  ```

### Projects

#### GET /projects/:id/branches
- List branches for a project.
- Query param: `branch` (optional, filter by branch name)

#### GET /projects/:id/tags
- List tags for a project.