# Express + Neon + AWS Backend Template

A TypeScript backend starter for building Express APIs with Neon PostgreSQL, Drizzle ORM, JWT authentication, and S3-compatible object storage. Use it as a foundation for SaaS products, internal tools, and other multi-tenant applications.

## Included

- Express 4 with JSON and URL-encoded request parsing
- TypeScript build and `nodemon` development workflow
- Neon serverless PostgreSQL through Drizzle ORM
- Drizzle schema and migration configuration
- JWT authentication with password hashing and secure cookies
- CORS, Helmet, request logging, centralized error handling, and a health check
- Multer and AWS SDK S3 client support for file uploads
- Neon Object Storage configuration through `neon.ts`

The starter currently includes user registration, login, logout, email verification, and password reset routes. Replace or extend these modules as your application grows.

## Quick Start

### 1. Install dependencies

```sh
npm install
```

### 2. Configure Neon

Create or select a Neon project, then link this repository to a branch:

```sh
npx neon@latest login
npx neon@latest link
npx neon@latest env pull --file .env.local
```

You can also create `.env.local` manually. The application accepts either `NEON_DATABASE_URL` or `DATABASE_URL` for the database connection.

### 3. Configure environment variables

At minimum, set a long random `ACCESS_TOKEN_SECRET` in `.env.local`:

```dotenv
ACCESS_TOKEN_SECRET=replace-with-a-long-random-secret
SALT_ROUNDS=12
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000

DATABASE_URL=your-neon-pooled-connection-string

AWS_ENDPOINT_URL_S3=your-s3-compatible-endpoint
AWS_REGION=your-storage-region
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_BUCKET_NAME=media
```

When using Neon Object Storage, the private `media` bucket is declared in `neon.ts`. `neon env pull` can populate the storage variables for a linked branch after the bucket is provisioned.

### 4. Create the database schema

Generate a migration after changing `src/config/schema.ts`, then apply pending migrations:

```sh
npm run dbGenerate
npm run dbMigrate
```

### 5. Start the API

Development mode reloads the TypeScript entrypoint on changes:

```sh
npm run dev
```

For a production-style local run:

```sh
npm run build
npm start
```

## API Surface

| Method   | Route                                    | Purpose                       |
| -------- | ---------------------------------------- | ----------------------------- |
| `GET`  | `/`                                    | Health check                  |
| `POST` | `/api/auth/register`                   | Register a user               |
| `POST` | `/api/auth/login`                      | Log in                        |
| `POST` | `/api/auth/logout`                     | Log out an authenticated user |
| `POST` | `/api/auth/forgot-password`            | Request a password reset      |
| `POST` | `/api/auth/reset-password/:resetToken` | Reset a password              |
| `POST` | `/api/auth/verify-email/:verifyToken`  | Verify an email address       |

Add feature routes in `src/routes`, business logic in `src/services`, persistence helpers in `src/repository`, and shared request/response types in `src/utils/types.ts`.

## Project Structure

```text
src/
  app.ts                 Express application and middleware setup
  config/                Database, storage, uploads, and Drizzle schema
  middlewares/           Authentication and error handling
  migrations/            Generated Drizzle SQL migrations
  repository/            Database access modules
  routes/                HTTP route definitions
  services/              Business logic
  utils/                 Environment validation and shared types
neon.ts                  Neon branch services and object storage config
drizzle.config.ts        Drizzle Kit configuration
```

## Common Commands

| Command                | Description                                 |
| ---------------------- | ------------------------------------------- |
| `npm run dev`        | Run the TypeScript API with reloads         |
| `npm run build`      | Compile TypeScript to`dist/`              |
| `npm start`          | Run the compiled API                        |
| `npm run dbGenerate` | Generate a Drizzle migration                |
| `npm run dbMigrate`  | Apply migrations to the configured database |

## Using This as a Template

1. Rename the package and update the project description in `package.json`.
2. Replace the starter tables in `src/config/schema.ts` with your domain model, or extend them for tenants, products, orders, and other features.
3. Add repositories, services, and routes for each bounded feature.
4. Update `neon.ts` when you need additional branch-provisioned Neon services or storage buckets.
5. Keep secrets in environment variables and use separate Neon branches for local development, previews, and production.

## Validation

```sh
npm run build
npm run dbGenerate
```

The application fails fast when the database URL or `ACCESS_TOKEN_SECRET` is missing. Database migrations, storage operations, and authenticated flows require the corresponding services and credentials to be available.

## License

MIT
