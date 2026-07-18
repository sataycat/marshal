import { useMutation, useQuery } from "@tanstack/react-query";
import * as api from "./client";
import { queryKeys } from "./queryKeys";
import type { TaskStatus } from "../types";

const queryOptions = { retry: 1, refetchOnWindowFocus: false } as const;

export function useTaskDetailQuery(slug: string) {
  return useQuery({ queryKey: queryKeys.task(slug), queryFn: ({ signal }) => api.fetchTaskDetail(slug, signal), ...queryOptions });
}
export function useRepositoriesQuery() {
  return useQuery({ queryKey: queryKeys.repositories, queryFn: ({ signal }) => api.fetchRepositories(signal), ...queryOptions });
}
export function useWorkflowProfilesQuery(repositoryId: string | null) { return useQuery({ queryKey: queryKeys.workflowProfiles(repositoryId ?? ""), queryFn: ({ signal }) => api.fetchWorkflowProfiles(repositoryId ?? "", signal), enabled: Boolean(repositoryId), ...queryOptions }); }
export const useCreateWorkflowProfileMutation = () => useMutation({ mutationFn: ({ repositoryId, input }: { repositoryId: string; input: api.WorkflowProfileInput }) => api.createWorkflowProfile(repositoryId, input) });
export const useUpdateWorkflowProfileMutation = () => useMutation({ mutationFn: ({ repositoryId, id, input }: { repositoryId: string; id: string; input: api.WorkflowProfileInput }) => api.updateWorkflowProfile(repositoryId, id, input) });
export const useDeleteWorkflowProfileMutation = () => useMutation({ mutationFn: ({ repositoryId, id }: { repositoryId: string; id: string }) => api.deleteWorkflowProfile(repositoryId, id) });
export function useRegistryQuery() {
  return useQuery({ queryKey: queryKeys.registry, queryFn: ({ signal }) => api.fetchRegistryCatalog(signal), ...queryOptions, refetchInterval: (query) => query.state.data?.refresh?.status === "running" ? 1000 : false });
}
export function useInstalledAgentsQuery() {
  return useQuery({ queryKey: queryKeys.installedAgents, queryFn: ({ signal }) => api.fetchInstalledAgents(signal), ...queryOptions, refetchInterval: (query) => query.state.data?.some((agent) => agent.status === "installing") ? 1000 : false });
}
export function useInstallationQuery(id: string | null) {
  return useQuery({ queryKey: queryKeys.installation(id ?? ""), queryFn: ({ signal }) => api.fetchInstallationOperation(id ?? "", signal), enabled: Boolean(id), ...queryOptions });
}
export const useRefreshRegistryMutation = () => useMutation({ mutationFn: api.refreshRegistry });
export const useInstallRegistryAgentMutation = () => useMutation({ mutationFn: ({ agentId, version }: { agentId: string; version: string }) => api.installRegistryAgent(agentId, version) });
export const useRemoveInstalledAgentMutation = () => useMutation({ mutationFn: ({ agentId, version }: { agentId: string; version: string }) => api.removeInstalledAgent(agentId, version) });
export const useProbeInstalledAgentMutation = () => useMutation({ mutationFn: ({ agentId, version }: { agentId: string; version: string }) => api.probeInstalledAgent(agentId, version) });
export const useAuthenticateInstalledAgentMutation = () => useMutation({ mutationFn: ({ agentId, version, methodId }: { agentId: string; version: string; methodId: string }) => api.authenticateInstalledAgent(agentId, version, methodId) });
export function useAgentAuthenticationQuery(agentId: string, version: string, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.agentAuthentication(agentId, version), queryFn: ({ signal }) => api.fetchAgentAuthentication(agentId, version, signal), enabled, ...queryOptions, refetchInterval: (query) => query.state.data?.authentication?.status === "authenticating" ? 1000 : false });
}
export const useCancelAgentAuthenticationMutation = () => useMutation({ mutationFn: api.cancelAgentAuthentication });
export const useRegisterRepositoryMutation = () => useMutation({ mutationFn: api.registerRepository });
export const useSelectRepositoryMutation = () => useMutation({ mutationFn: api.selectRepository });
export const useRemoveRepositoryMutation = () => useMutation({ mutationFn: api.removeRepository });
export function useTaskDiffQuery(slug: string, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.taskDiff(slug), queryFn: ({ signal }) => api.fetchTaskDiff(slug, signal), enabled, ...queryOptions });
}
export function useSpecMessagesQuery(slug: string) {
  return useQuery({ queryKey: queryKeys.specMessages(slug), queryFn: ({ signal }) => api.fetchSpecMessages(slug, signal), ...queryOptions });
}
export function useChatAgentsQuery() {
  return useInstalledAgentsQuery();
}
export function useChatThreadsQuery(archived: boolean) {
  return useQuery({ queryKey: queryKeys.threads(archived), queryFn: ({ signal }) => api.fetchChatThreads(archived, signal), ...queryOptions });
}
export function useChatThreadQuery(id: string | undefined) {
  return useQuery({ queryKey: queryKeys.thread(id ?? ""), queryFn: ({ signal }) => api.fetchChatThread(id ?? "", signal), enabled: Boolean(id), ...queryOptions });
}
export function useChatFilesQuery(id: string | undefined) {
  return useQuery({ queryKey: queryKeys.files(id ?? ""), queryFn: ({ signal }) => api.fetchChatFiles(id ?? "", signal), enabled: Boolean(id), ...queryOptions });
}
export function useChatFileQuery(id: string | undefined, path: string | undefined) {
  return useQuery({ queryKey: queryKeys.file(id ?? "", path ?? ""), queryFn: ({ signal }) => api.fetchChatFile(id ?? "", path ?? "", signal), enabled: Boolean(id && path), ...queryOptions });
}
export function useChatPermissionsQuery(id: string | undefined) {
  return useQuery({ queryKey: queryKeys.permissions(id ?? ""), queryFn: ({ signal }) => api.fetchChatPermissions(id ?? "", signal), enabled: Boolean(id), ...queryOptions });
}
export function useChatAttachmentsQuery(id: string | undefined) {
  return useQuery({ queryKey: queryKeys.attachments(id ?? ""), queryFn: ({ signal }) => api.fetchChatAttachments(id ?? "", signal), enabled: Boolean(id), ...queryOptions });
}
export const useCreateThreadMutation = () => useMutation({ mutationFn: api.createChatThread });
export const useUpdateThreadMutation = () => useMutation({ mutationFn: ({ id, input }: { id: string; input: Parameters<typeof api.updateChatThread>[1] }) => api.updateChatThread(id, input) });
export const useDeleteThreadMutation = () => useMutation({ mutationFn: api.deleteChatThread });
export const useSendChatMutation = () => useMutation({ mutationFn: ({ id, content, attachmentIds }: { id: string; content: string; attachmentIds?: string[] }) => api.sendChatMessage(id, content, attachmentIds) });
export const useCancelChatMutation = () => useMutation({ mutationFn: api.cancelChatTurn });
export const usePermissionMutation = () => useMutation({ mutationFn: ({ id, requestId, action }: { id: string; requestId: string; action: "approve" | "deny" }) => api.decideChatPermission(id, requestId, action) });
export const useUploadAttachmentMutation = () => useMutation({ mutationFn: ({ id, file }: { id: string; file: File }) => api.uploadChatAttachment(id, file) });
export const useSendSpecMessageMutation = () => useMutation({ mutationFn: ({ slug, content }: { slug: string; content: string }) => api.sendSpecMessage(slug, content) });
export const useCreateTaskMutation = () => useMutation({ mutationFn: api.createTask });
export const useFreezeTaskMutation = () => useMutation({ mutationFn: ({ slug, specMarkdown }: { slug: string; specMarkdown?: string }) => api.freezeTask(slug, specMarkdown) });
export const useTransitionTaskMutation = () => useMutation({ mutationFn: ({ slug, to }: { slug: string; to: TaskStatus }) => api.transitionTask(slug, to) });
export const useMergeTaskMutation = () => useMutation({ mutationFn: api.mergeTask });
export const useUpdateTaskSpecMutation = () => useMutation({ mutationFn: ({ slug, specMarkdown }: { slug: string; specMarkdown: string }) => api.updateTaskSpec(slug, specMarkdown) });
