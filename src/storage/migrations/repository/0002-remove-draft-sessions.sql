DELETE FROM permission_requests WHERE thread_id IN (SELECT id FROM chat_threads WHERE status = 'draft');
DELETE FROM acp_events WHERE session_id IN (SELECT id FROM acp_sessions WHERE owner_type = 'thread' AND owner_id IN (SELECT id FROM chat_threads WHERE status = 'draft'));
DELETE FROM acp_prompts WHERE session_id IN (SELECT id FROM acp_sessions WHERE owner_type = 'thread' AND owner_id IN (SELECT id FROM chat_threads WHERE status = 'draft'));
DELETE FROM acp_sessions WHERE owner_type = 'thread' AND owner_id IN (SELECT id FROM chat_threads WHERE status = 'draft');
DELETE FROM chat_threads WHERE status = 'draft';
