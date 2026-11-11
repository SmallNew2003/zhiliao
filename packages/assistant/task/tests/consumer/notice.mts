/** Published assistant message sources narrow from the package root under NodeNext. */
import type { AssistantTaskId } from '@deepseek-ai/dsh-assistant-task'
import type { MessageSource } from '@deepseek-ai/dsh-llm'

function taskOf(source: MessageSource): AssistantTaskId | undefined {
  return source.kind === 'assistant-task' ? source.taskId : undefined
}
void taskOf
