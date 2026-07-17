import { useMutation, useQuery } from "@tanstack/react-query";
import * as api from "./client";
import { queryKeys } from "./queryKeys";
import type { TaskStatus } from "../types";

const queryOptions = { retry: 1, refetchOnWindowFocus: false } as const;

export function useTaskDetailQuery(slug: string) {
  return useQuery({ queryKey: queryKeys.task(slug), queryFn: ({ signal }) => api.fetchTaskDetail(slug, signal), ...queryOptions });
}
export function useTaskDiffQuery(slug: string, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.taskDiff(slug), queryFn: ({ signal }) => api.fetchTaskDiff(slug, signal), enabled, ...queryOptions });
}
export function useSpecMessagesQuery(slug: string) {
  return useQuery({ queryKey: queryKeys.specMessages(slug), queryFn: ({ signal }) => api.fetchSpecMessages(slug, signal), ...queryOptions });
}
export function useChatAgentsQuery() {
  return useQuery({ queryKey: queryKeys.chatAgents, queryFn: ({ signal }) => api.fetchChatAgents(signal), ...queryOptions });
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
