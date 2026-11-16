# TodoList

A free dashboard for students who also work. Once you connect your sources, TodoList shows today, this week and every deadline across:

- Moodle
- Jira and ClickUp
- Linear
- GitHub
- Google Calendar

You can also:

- build your own pages from blocks;
- share a workspace with classmates;
- let AI agents read and build pages through MCP.
  > **Status:** built, not deployed yet. Every stage is deployed from this repo with AWS CDK; see [Deployment](docs/deployment.md).

## Architecture

One CloudFormation stack per stage (`dev`, `qa`, `prod`): CloudFront and S3 for the client, API Gateway and **one Lambda function** (`todolist-<stage>-api`, one role, two layers, one log group) for the Express API, Cognito, SES, Route 53, ACM and an optional WAF. Data lives in MongoDB (`DATABASE_URL`). There are no queues, workers or schedules: emails go straight to SES, and a background sync is an asynchronous invoke of the same function. Nothing runs on a timer for now (see [TODO.md](TODO.md)). Details in [Infrastructure](docs/infrastructure.md).

## Getting started

**You need:** Node.js 22 or newer (24 recommended), Python 3.10 or newer (only for the browser tests), an AWS account with a Route 53 hosted zone, and a MongoDB database (Atlas).

```bash
npm install && (cd server && npm install) && (cd client && npm install)
```

### 1. Configure a stage

Copy [`server/.env.example`](server/.env.example) to `server/.env.<stage>` (`dev`, `qa`, `prod`; git-ignored) and fill in the variables below. Nothing else is configured by an environment variable: behaviour is fixed in code, and app secrets (OAuth client secrets, provider tokens) live in AWS Secrets Manager ([INTEGRATIONS-SETUP.md](INTEGRATIONS-SETUP.md)).

| Variable              | Required                           | Description                                                                           |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `AWS_ACCOUNT_ID`      | CI                                 | Builds the OIDC role ARN                                                              |
| `AWS_ROLE_NAME`       | CI                                 | Name of the GitHub OIDC role CI assumes                                               |
| `AWS_REGION`          | no                                 | Stack region, defaults to `us-east-1`                                                 |
| `DOMAIN_NAME`         | yes                                | Stage domain inside a Route 53 hosted zone; also names the S3 buckets                 |
| `DATABASE_URL`        | yes                                | MongoDB connection string                                                             |
| `CERTIFICATE_ARN`     | if `AWS_REGION` is not `us-east-1` | ACM certificate in `us-east-1` covering every stage domain                            |
| `WAF_WEB_ACL_ARN`     | no                                 | Existing global WAF web ACL for CloudFront ([Staging access](docs/staging-access.md)) |
| `BASIC_AUTH_PASSWORD` | `dev` and `qa`                     | Basic-auth password of the host; the username is `DOMAIN_NAME`                        |

### 2. Deploy

One-time per AWS account: `cdk bootstrap`, a GitHub OIDC role and the GitHub secrets and variables. Full steps in [Deployment](docs/deployment.md). Then push `dev`, `qa` or `main` and CI deploys, or deploy by hand:

```bash
aws sso login
cd server
npm run deploy:backend -- dev    # stack + database schema
npm run deploy:frontend -- dev   # client to S3 + CloudFront invalidation
```

### 3. Run locally against the stage

The local API is the same Express app the Lambda runs, wired to the deployed stage's Cognito, database and resources, so it needs AWS credentials and a deployed stage.

```bash
cd server && npm run dev          # API on http://localhost:3000/api (stage dev; also: npm run qa, npm run prod)
cd client && npm run dev          # app on http://localhost:5173
```

### 4. Test

```bash
cd server && npm run test:unit && npm run test:infra
cd server && npm run test:local   # Postman against the local API (stage-backed)
cd client && npm run test:unit
cd client && npm run test:install && npm run test   # Playwright E2E, stage-backed
```

> [!WARNING]
> `cd server && npm run reset:db -- <dev|qa>` **empties that stage** (database, S3 uploads, Cognito users). It refuses prod. Read [Frontend tests](client/tests/README.md) first.

## Where things live

| Path                                           | What                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `client/`                                      | React 19 + Vite + Tailwind v4 + shadcn/ui web app, Playwright tests |
| `server/`                                      | Express 5 API (one AWS Lambda), Mongoose, AWS CDK in `server/infra` |
| `docs/dashboard/`                              | Product design docs (start with `OVERVIEW.md`) and `DECISIONS.md`   |
| `docs/deployment.md`, `docs/infrastructure.md` | AWS stages (dev, qa, prod), CI/CD and infrastructure                |
| `postman/`                                     | API tests ([README](postman/README.md))                             |
| `agent-plugin/`                                | Claude Code and Cursor plugin for the MCP server                    |

## Credits

Built on [Elytra](https://github.com/shalev396/Elytra), an MIT-licensed full-stack serverless template.

## License

MIT, see [LICENSE](LICENSE).
