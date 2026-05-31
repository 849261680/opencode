import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project/:projectID/copy"

export const CreatePayload = Schema.Struct({
  strategy: ProjectCopy.StrategyID,
  path: ProjectCopy.CreateInput.fields.path,
})
export const RemovePayload = Schema.Struct({
  strategy: ProjectCopy.StrategyID,
  path: ProjectCopy.RemoveInput.fields.path,
})
export const RefreshPayload = Schema.Struct({
  strategy: Schema.optional(ProjectCopy.StrategyID),
})

export const ProjectCopyApi = HttpApi.make("projectCopy")
  .add(
    HttpApiGroup.make("projectCopy")
      .add(
        HttpApiEndpoint.get("strategies", `${root}/strategy`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(ProjectCopy.StrategyInfo), "Project copy strategies"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "projectCopy.strategies",
            summary: "List project copy strategies",
            description: "List mechanisms available for managing local copies of a project.",
          }),
        ),
        HttpApiEndpoint.post("create", root, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: CreatePayload,
          success: described(ProjectCopy.Copy, "Project copy created"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "projectCopy.create",
            summary: "Create project copy",
            description: "Create a local physical copy of a project using the selected strategy.",
          }),
        ),
        HttpApiEndpoint.delete("remove", root, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: RemovePayload,
          success: described(HttpApiSchema.NoContent, "Project copy removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "projectCopy.remove",
            summary: "Remove project copy",
            description: "Remove a local physical copy of a project using the selected strategy.",
          }),
        ),
        HttpApiEndpoint.post("refresh", `${root}/refresh`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: RefreshPayload,
          success: described(HttpApiSchema.NoContent, "Project copies refreshed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "projectCopy.refresh",
            summary: "Refresh project copies",
            description: "Discover local project copies using one or all configured strategies.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "projectCopy", description: "Project copy management routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
