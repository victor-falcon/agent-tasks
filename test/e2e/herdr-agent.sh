#!/bin/sh
# Stand-in for a coding agent in the Herdr end-to-end test (no LLM). Like the
# run-agent-task skill, it reads its run with `agent-tasks task` and reports
# with `agent-tasks finish`. A line "E2E_RESULT: failed" in the task's
# instructions makes it report a failure.
#
# It waits for a file named "release-<task id>" in its folder before it
# finishes, so the test can inspect the live terminal first. After finish it
# stays open, like a real agent sitting at its prompt, until its session is
# closed.
set -u
ref="${AGENT_TASKS_RUN:?AGENT_TASKS_RUN is not set}"
task_id="${ref%%/*}"
task=$(agent-tasks task "$ref") || exit 1
status=succeeded
case "$task" in *"E2E_RESULT: failed"*) status=failed ;; esac

echo "e2e agent: $ref will finish as $status once release-$task_id exists"
while [ ! -e "release-$task_id" ]; do sleep 1; done
agent-tasks finish "$ref" --status "$status" --summary "e2e agent finished as $status"
echo "e2e agent: finished; waiting to be closed"
while :; do sleep 5; done
