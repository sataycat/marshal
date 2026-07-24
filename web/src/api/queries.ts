import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./client";
import { queryKeys } from "./queryKeys";
import type { TaskStatus } from "../types";
import { isTerminalInstallationOperation } from "../state/installationOperations";

const queryOptions = { retry: 1, refetchOnWindowFocus: false } as const;

export function useTaskDetailQuery(slug: string, repositoryId: string | null) {
  return useQuery({
    queryKey: queryKeys.task(slug, repositoryId),
    queryFn: ({ signal }) => api.fetchTaskDetail(slug, repositoryId!, signal),
    enabled: Boolean(repositoryId),
    ...queryOptions,
  });
}
export function useTaskRunsQuery(slug: string, repositoryId: string | null) {
  return useQuery({
    queryKey: queryKeys.taskRuns(slug, repositoryId),
    queryFn: ({ signal }) => api.fetchTaskRuns(slug, repositoryId!, signal),
    enabled: Boolean(repositoryId),
    ...queryOptions,
  });
}
export const useRecoverRunAuthenticationMutation = () =>
  useMutation({ mutationFn: ({ runId, repositoryId }: { runId: number; repositoryId: string }) => api.recoverRunAuthentication(runId, repositoryId) });
export function useRepositoriesQuery() {
  return useQuery({
    queryKey: queryKeys.repositories,
    queryFn: ({ signal }) => api.fetchRepositories(signal),
    ...queryOptions,
  });
}
export function useDirectorySuggestionsQuery(path: string, query: string, enabled = true) {
  return useQuery({
    queryKey: ["repository-directories", path, query],
    queryFn: ({ signal }) => api.fetchDirectorySuggestions(path, query, signal),
    enabled,
    ...queryOptions,
  });
}
export function useDiagnosticsQuery() {
  return useQuery({
    queryKey: queryKeys.diagnostics,
    queryFn: ({ signal }) => api.fetchDiagnostics(signal),
    ...queryOptions,
    refetchInterval: 5000,
  });
}
export function useWorkflowProfilesQuery(repositoryId: string | null) {
  return useQuery({
    queryKey: queryKeys.workflowProfiles(repositoryId ?? ""),
    queryFn: ({ signal }) => api.fetchWorkflowProfiles(repositoryId ?? "", signal),
    enabled: Boolean(repositoryId),
    ...queryOptions,
  });
}
export const useCreateWorkflowProfileMutation = () =>
  useMutation({
    mutationFn: ({
      repositoryId,
      input,
    }: {
      repositoryId: string;
      input: api.WorkflowProfileInput;
    }) => api.createWorkflowProfile(repositoryId, input),
  });
export const useUpdateWorkflowProfileMutation = () =>
  useMutation({
    mutationFn: ({
      repositoryId,
      id,
       input,
    }: {
      repositoryId: string;
      id: string;
      input: api.WorkflowProfileInput;
    }) => api.updateWorkflowProfile(repositoryId, id, input),
  });
export const useDeleteWorkflowProfileMutation = () =>
  useMutation({
    mutationFn: ({ repositoryId, id }: { repositoryId: string; id: string }) =>
      api.deleteWorkflowProfile(repositoryId, id),
  });
export function useRegistryQuery() {
  return useQuery({
    queryKey: queryKeys.registry,
    queryFn: ({ signal }) => api.fetchRegistryCatalog(signal),
    ...queryOptions,
    refetchInterval: (query) => (query.state.data?.refresh?.status === "running" ? 1000 : false),
  });
}
export function useInstallCandidateQuery(
  agentId: string | null,
  version: string | null,
  distribution?: "npx" | "uvx" | "binary",
) {
  return useQuery({
    queryKey: [
      ...queryKeys.registry,
      "candidate",
      agentId ?? "",
      version ?? "",
      distribution ?? "auto",
    ],
    queryFn: ({ signal }) => api.fetchInstallCandidate(agentId!, version!, distribution, signal),
    enabled: Boolean(agentId && version),
    ...queryOptions,
  });
}
export function useInstalledAgentsQuery() {
  return useQuery({
    queryKey: queryKeys.installedAgents,
    queryFn: ({ signal }) => api.fetchInstalledAgents(signal),
    ...queryOptions,
    refetchInterval: (query) =>
      query.state.data?.some(
        (agent) => agent.status === "installing" || agent.readiness_status === "probing",
      )
        ? 1000
        : false,
  });
}
export function useInstallationQuery(id: string | null) {
  return useQuery({
    queryKey: queryKeys.installation(id ?? ""),
    queryFn: ({ signal }) => api.fetchInstallationOperation(id ?? "", signal),
    enabled: Boolean(id),
    ...queryOptions,
    refetchInterval: (query) =>
      query.state.data && isTerminalInstallationOperation(query.state.data) ? false : 1000,
  });
}
export function useInstallationOperationsQuery() {
  return useQuery({
    queryKey: [...queryKeys.installedAgents, "operations"],
    queryFn: ({ signal }) => api.fetchInstallationOperations(signal),
    ...queryOptions,
    refetchInterval: (query) =>
      query.state.data?.some((operation) => !isTerminalInstallationOperation(operation))
        ? 1000
        : false,
  });
}
export const useRefreshRegistryMutation = () => useMutation({ mutationFn: api.refreshRegistry });
export const useInstallRegistryAgentMutation = () =>
  useMutation({
    mutationFn: ({
      agentId,
      version,
      distribution,
    }: {
      agentId: string;
      version: string;
      distribution?: "npx" | "uvx" | "binary";
    }) => api.installRegistryAgent(agentId, version, distribution),
  });
export const useUpdateRegistryAgentMutation = () =>
  useMutation({
    mutationFn: ({
      agentId,
      version,
      distribution,
    }: {
      agentId: string;
      version: string;
      distribution?: "npx" | "uvx" | "binary";
    }) => api.updateRegistryAgent(agentId, version, distribution),
  });
export const useSetDefaultInstalledAgentMutation = () =>
  useMutation({
    mutationFn: ({ agentId, installationId }: { agentId: string; installationId: string }) =>
      api.setDefaultInstalledAgent(agentId, installationId),
  });
export const useRemoveInstalledAgentMutation = () =>
  useMutation({
    mutationFn: ({
      agentId,
      version,
      installationId,
    }: {
      agentId: string;
      version: string;
      installationId?: string;
    }) => api.removeInstalledAgent(agentId, version, installationId),
  });
export const useRetryAgentRemovalMutation = () =>
  useMutation({ mutationFn: api.retryAgentRemoval });
export const useProbeInstalledAgentMutation = () =>
  useMutation({
    mutationFn: ({
      agentId,
      version,
      installationId,
    }: {
      agentId: string;
      version: string;
      installationId?: string;
    }) => api.probeInstalledAgent(agentId, version, installationId),
  });
export const useAuthenticateInstalledAgentMutation = () =>
  useMutation({
    mutationFn: ({
      agentId,
      version,
      methodId,
      installationId,
      values,
    }: {
      agentId: string;
      version: string;
      methodId: string;
      installationId?: string;
      values?: Record<string, string>;
    }) => api.authenticateInstalledAgent(agentId, version, methodId, installationId, values),
  });
export function useAgentAuthenticationQuery(
  agentId: string,
  version: string,
  installationId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.agentAuthentication(agentId, version, installationId),
    queryFn: ({ signal }) => api.fetchAgentAuthentication(agentId, version, installationId, signal),
    enabled,
    ...queryOptions,
    refetchInterval: (query) =>
      query.state.data?.authentication?.status === "authenticating" ? 1000 : false,
  });
}
export const useCancelAgentAuthenticationMutation = () =>
  useMutation({ mutationFn: api.cancelAgentAuthentication });
export const useRegisterRepositoryMutation = () =>
  useMutation({ mutationFn: api.registerRepository });
export const useSelectRepositoryMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.selectRepository,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.repositories }),
  });
};
export const useRemoveRepositoryMutation = () => useMutation({ mutationFn: api.removeRepository });
export function useTaskDiffQuery(slug: string, repositoryId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.taskDiff(slug, repositoryId),
    queryFn: ({ signal }) => api.fetchTaskDiff(slug, repositoryId!, signal),
    enabled: enabled && Boolean(repositoryId),
    ...queryOptions,
  });
}
export function useSpecMessagesQuery(slug: string, repositoryId: string | null) {
  return useQuery({
    queryKey: queryKeys.specMessages(slug, repositoryId),
    queryFn: ({ signal }) => api.fetchSpecMessages(slug, repositoryId!, signal),
    enabled: Boolean(repositoryId),
    ...queryOptions,
  });
}
export function useSpecAuthorSessionsQuery(slug: string, repositoryId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.specMessages(slug, repositoryId), "sessions"],
    queryFn: ({ signal }) => api.fetchSpecAuthorSessions(slug, repositoryId!, signal),
    enabled: Boolean(repositoryId),
    ...queryOptions,
  });
}
export function useChatAgentsQuery() {
  return useInstalledAgentsQuery();
}
export function useChatThreadsQuery(repositoryId: string | null, archived: boolean) {
  return useQuery({
    queryKey: queryKeys.threads(archived, repositoryId),
    queryFn: ({ signal }) => api.fetchChatThreads(repositoryId!, archived, signal),
    enabled: Boolean(repositoryId),
    ...queryOptions,
  });
}
export function useChatThreadQuery(id: string | undefined, repositoryId: string | null) {
  return useQuery({
    queryKey: queryKeys.thread(id ?? "", repositoryId),
    queryFn: ({ signal }) => api.fetchChatThread(id ?? "", repositoryId!, signal),
    enabled: Boolean(id && repositoryId),
    ...queryOptions,
  });
}
export function useChatFilesQuery(id: string | undefined, repositoryId: string | null) {
  return useQuery({
    queryKey: queryKeys.files(id ?? "", repositoryId),
    queryFn: ({ signal }) => api.fetchChatFiles(id ?? "", repositoryId!, signal),
    enabled: Boolean(id && repositoryId),
    ...queryOptions,
  });
}
export function useChatFileQuery(id: string | undefined, repositoryId: string | null, path: string | undefined) {
  return useQuery({
    queryKey: queryKeys.file(id ?? "", path ?? "", repositoryId),
    queryFn: ({ signal }) => api.fetchChatFile(id ?? "", repositoryId!, path ?? "", signal),
    enabled: Boolean(id && repositoryId && path),
    ...queryOptions,
  });
}
export function useChatPermissionsQuery(id: string | undefined, repositoryId: string | null) {
  return useQuery({
    queryKey: queryKeys.permissions(id ?? "", repositoryId),
    queryFn: ({ signal }) => api.fetchChatPermissions(id ?? "", repositoryId!, signal),
    enabled: Boolean(id && repositoryId),
    ...queryOptions,
  });
}
export function useChatAttachmentsQuery(id: string | undefined, repositoryId: string | null) {
  return useQuery({
    queryKey: queryKeys.attachments(id ?? "", repositoryId),
    queryFn: ({ signal }) => api.fetchChatAttachments(id ?? "", repositoryId!, signal),
    enabled: Boolean(id && repositoryId),
    ...queryOptions,
  });
}
export const useCreateThreadMutation = () => useMutation({ mutationFn: api.createChatThread });
export const useUpdateThreadMutation = () =>
  useMutation({
    mutationFn: ({
      id,
      repositoryId,
      input,
    }: {
      id: string;
       repositoryId: string;
       input: Parameters<typeof api.updateChatThread>[2];
    }) => api.updateChatThread(id, repositoryId, input),
  });
export const useDeleteThreadMutation = () => useMutation({ mutationFn: ({ id, repositoryId }: { id: string; repositoryId: string }) => api.deleteChatThread(id, repositoryId) });
export const useInitializeChatSessionMutation = () =>
  useMutation({ mutationFn: ({ id, repositoryId }: { id: string; repositoryId: string }) => api.initializeChatSession(id, repositoryId) });
export const useSetChatSessionConfigOptionMutation = () =>
  useMutation({
    mutationFn: ({
      id,
       configId,
       value,
       repositoryId,
    }: {
      id: string;
      configId: string;
       value: string | boolean;
       repositoryId: string;
    }) => api.setChatSessionConfigOption(id, repositoryId, configId, value),
  });
export const useSetChatSessionModeMutation = () =>
  useMutation({
    mutationFn: ({ id, modeId, repositoryId }: { id: string; modeId: string; repositoryId: string }) =>
      api.setChatSessionMode(id, repositoryId, modeId),
  });
export const useSendChatMutation = () =>
  useMutation({
    mutationFn: ({
       id,
       content,
       attachmentIds,
       repositoryId,
    }: {
      id: string;
      content: string;
       attachmentIds?: string[];
       repositoryId: string;
    }) => api.sendChatMessage(id, repositoryId, content, attachmentIds),
  });
export const useResubmitChatMutation = () =>
  useMutation({
    mutationFn: ({ id, messageId, repositoryId }: { id: string; messageId: number; repositoryId: string }) =>
      api.resubmitChatMessage(id, repositoryId, messageId),
  });
export const useCancelChatMutation = () => useMutation({ mutationFn: ({ id, repositoryId }: { id: string; repositoryId: string }) => api.cancelChatTurn(id, repositoryId) });
export const usePermissionMutation = () =>
  useMutation({
    mutationFn: ({
       id,
       requestId,
       action,
       repositoryId,
    }: {
      id: string;
      requestId: string;
       action: "approve" | "deny";
       repositoryId: string;
    }) => api.decideChatPermission(id, repositoryId, requestId, action),
  });
export const useUploadAttachmentMutation = () =>
  useMutation({
    mutationFn: ({ id, repositoryId, file }: { id: string; repositoryId: string; file: File }) => api.uploadChatAttachment(id, repositoryId, file),
  });
export const useSendSpecMessageMutation = () =>
  useMutation({
      mutationFn: ({ slug, repositoryId, content }: { slug: string; repositoryId: string; content: string }) =>
      api.sendSpecMessage(slug, repositoryId, content),
  });
export const useResubmitSpecMessageMutation = () =>
  useMutation({
      mutationFn: ({ slug, repositoryId, messageId }: { slug: string; repositoryId: string; messageId: number }) =>
      api.resubmitSpecMessage(slug, repositoryId, messageId),
  });
export const useCreateTaskMutation = () => useMutation({ mutationFn: api.createTask });
export const useFreezeTaskMutation = () =>
  useMutation({
    mutationFn: ({ slug, repositoryId, specMarkdown }: { slug: string; repositoryId: string; specMarkdown?: string }) =>
      api.freezeTask(slug, repositoryId, specMarkdown),
  });
export const useTransitionTaskMutation = () =>
  useMutation({
    mutationFn: ({ slug, repositoryId, to }: { slug: string; repositoryId: string; to: TaskStatus }) => api.transitionTask(slug, repositoryId, to),
  });
export const useMergeTaskMutation = () => useMutation({ mutationFn: ({ slug, repositoryId }: { slug: string; repositoryId: string }) => api.mergeTask(slug, repositoryId) });
export const useUpdateTaskSpecMutation = () =>
  useMutation({
    mutationFn: ({ slug, repositoryId, specMarkdown }: { slug: string; repositoryId: string; specMarkdown: string }) =>
      api.updateTaskSpec(slug, repositoryId, specMarkdown),
  });
