/** Assistant surface copy in every supported client locale. */

/** Locale namespace for the assistant surface. */
export const NS = 'assistant'

/** Localized assistant navigation, task status, and failure messages. */
export interface AssistantLocale {
  readonly panel: string
  readonly title: string
  readonly selector: string
  readonly global: string
  readonly project: string
  readonly tasks: string
  readonly empty: string
  readonly open: string
  readonly openAssistant: string
  readonly cancel: string
  readonly refresh: string
  readonly retry: string
  readonly loading: string
  readonly loadError: string
  readonly cancelError: string
  readonly noProjects: string
  readonly headerAssistant: string
  readonly headerAssistantTask: string
  readonly backToAssistant: string
  readonly statusCreated: string
  readonly statusRunning: string
  readonly statusWaitingApproval: string
  readonly statusWaitingAnswer: string
  readonly statusDone: string
  readonly statusFailed: string
  readonly statusCancelled: string
  readonly failureNotStarted: string
  readonly failureInterrupted: string
  readonly failureTurnError: string
  readonly failureExecution: string
  readonly failurePrompt: string
  readonly failureStore: string
  readonly failureQuota: string
  readonly failureScope: string
  readonly failureNotAllowed: string
  readonly failureUnknown: string
}

/** Chinese assistant messages. */
export const zh: AssistantLocale = {
  panel: '助理',
  title: '助理',
  selector: '选择助理',
  global: '全局助理',
  project: '项目助理',
  tasks: '任务',
  empty: '还没有任务',
  open: '打开任务',
  openAssistant: '打开助理会话',
  cancel: '取消任务',
  refresh: '刷新',
  retry: '重试',
  loading: '正在加载',
  loadError: '助理任务加载失败',
  cancelError: '取消任务失败',
  noProjects: '还没有项目',
  headerAssistant: '助理会话',
  headerAssistantTask: '助理任务',
  backToAssistant: '返回助理',
  statusCreated: '已创建',
  statusRunning: '运行中',
  statusWaitingApproval: '等待审批',
  statusWaitingAnswer: '等待回答',
  statusDone: '已完成',
  statusFailed: '失败',
  statusCancelled: '已取消',
  failureNotStarted: '任务没有创建执行会话',
  failureInterrupted: '任务因主机重启而中断',
  failureTurnError: '任务执行出错',
  failureExecution: '任务执行环境不可用',
  failurePrompt: '任务指令未能送达',
  failureStore: '任务记录写入失败',
  failureQuota: '已达到助理任务上限',
  failureScope: '任务不在该助理的项目范围内',
  failureNotAllowed: '当前会话不能创建助理任务',
  failureUnknown: '任务失败',
}

/** English assistant messages. */
export const en: AssistantLocale = {
  panel: 'Assistant',
  title: 'Assistant',
  selector: 'Choose an assistant',
  global: 'Global assistant',
  project: 'Project assistant',
  tasks: 'Tasks',
  empty: 'No tasks yet',
  open: 'Open task',
  openAssistant: 'Open assistant conversation',
  cancel: 'Cancel task',
  refresh: 'Refresh',
  retry: 'Retry',
  loading: 'Loading',
  loadError: 'Assistant tasks could not be loaded',
  cancelError: 'The task could not be cancelled',
  noProjects: 'No projects yet',
  headerAssistant: 'Assistant conversation',
  headerAssistantTask: 'Assistant task',
  backToAssistant: 'Back to assistant',
  statusCreated: 'Created',
  statusRunning: 'Running',
  statusWaitingApproval: 'Waiting for approval',
  statusWaitingAnswer: 'Waiting for answer',
  statusDone: 'Done',
  statusFailed: 'Failed',
  statusCancelled: 'Cancelled',
  failureNotStarted: 'The task never reached an execution Session',
  failureInterrupted: 'The task was interrupted when the Host restarted',
  failureTurnError: 'The task execution failed',
  failureExecution: 'The task execution environment is unavailable',
  failurePrompt: 'The task instruction could not be delivered',
  failureStore: 'The task record could not be stored',
  failureQuota: 'The assistant reached its task limit',
  failureScope: 'The task is outside this assistant\'s project',
  failureNotAllowed: 'This conversation cannot create assistant tasks',
  failureUnknown: 'The task failed',
}

/** Japanese assistant messages. */
export const ja: AssistantLocale = {
  panel: 'アシスタント',
  title: 'アシスタント',
  selector: 'アシスタントを選択',
  global: 'グローバルアシスタント',
  project: 'プロジェクトアシスタント',
  tasks: 'タスク',
  empty: 'タスクはまだありません',
  open: 'タスクを開く',
  openAssistant: 'アシスタントの会話を開く',
  cancel: 'タスクをキャンセル',
  refresh: '更新',
  retry: '再試行',
  loading: '読み込み中',
  loadError: 'アシスタントのタスクを読み込めませんでした',
  cancelError: 'タスクをキャンセルできませんでした',
  noProjects: 'プロジェクトはまだありません',
  headerAssistant: 'アシスタントの会話',
  headerAssistantTask: 'アシスタントのタスク',
  backToAssistant: 'アシスタントに戻る',
  statusCreated: '作成済み',
  statusRunning: '実行中',
  statusWaitingApproval: '承認待ち',
  statusWaitingAnswer: '回答待ち',
  statusDone: '完了',
  statusFailed: '失敗',
  statusCancelled: 'キャンセル済み',
  failureNotStarted: 'タスクの実行セッションが作成されませんでした',
  failureInterrupted: 'ホストの再起動によりタスクが中断されました',
  failureTurnError: 'タスクの実行に失敗しました',
  failureExecution: 'タスクの実行環境を利用できません',
  failurePrompt: 'タスクの指示を配信できませんでした',
  failureStore: 'タスクの記録を保存できませんでした',
  failureQuota: 'アシスタントのタスク上限に達しました',
  failureScope: 'タスクはこのアシスタントのプロジェクト外です',
  failureNotAllowed: 'この会話ではアシスタントのタスクを作成できません',
  failureUnknown: 'タスクに失敗しました',
}

/** Spanish assistant messages. */
export const es: AssistantLocale = {
  panel: 'Asistente',
  title: 'Asistente',
  selector: 'Elegir un asistente',
  global: 'Asistente global',
  project: 'Asistente del proyecto',
  tasks: 'Tareas',
  empty: 'Aún no hay tareas',
  open: 'Abrir tarea',
  openAssistant: 'Abrir la conversación del asistente',
  cancel: 'Cancelar tarea',
  refresh: 'Actualizar',
  retry: 'Reintentar',
  loading: 'Cargando',
  loadError: 'No se pudieron cargar las tareas del asistente',
  cancelError: 'No se pudo cancelar la tarea',
  noProjects: 'Aún no hay proyectos',
  headerAssistant: 'Conversación del asistente',
  headerAssistantTask: 'Tarea del asistente',
  backToAssistant: 'Volver al asistente',
  statusCreated: 'Creada',
  statusRunning: 'En ejecución',
  statusWaitingApproval: 'Esperando aprobación',
  statusWaitingAnswer: 'Esperando respuesta',
  statusDone: 'Completada',
  statusFailed: 'Fallida',
  statusCancelled: 'Cancelada',
  failureNotStarted: 'La tarea nunca llegó a una sesión de ejecución',
  failureInterrupted: 'La tarea se interrumpió al reiniciar el Host',
  failureTurnError: 'La ejecución de la tarea falló',
  failureExecution: 'El entorno de ejecución de la tarea no está disponible',
  failurePrompt: 'No se pudo entregar la instrucción de la tarea',
  failureStore: 'No se pudo guardar el registro de la tarea',
  failureQuota: 'El asistente alcanzó su límite de tareas',
  failureScope: 'La tarea está fuera del proyecto de este asistente',
  failureNotAllowed: 'Esta conversación no puede crear tareas del asistente',
  failureUnknown: 'La tarea falló',
}

/** French assistant messages. */
export const fr: AssistantLocale = {
  panel: 'Assistant',
  title: 'Assistant',
  selector: 'Choisir un assistant',
  global: 'Assistant global',
  project: 'Assistant du projet',
  tasks: 'Tâches',
  empty: 'Aucune tâche pour le moment',
  open: 'Ouvrir la tâche',
  openAssistant: 'Ouvrir la conversation de l’assistant',
  cancel: 'Annuler la tâche',
  refresh: 'Actualiser',
  retry: 'Réessayer',
  loading: 'Chargement',
  loadError: 'Impossible de charger les tâches de l’assistant',
  cancelError: 'Impossible d’annuler la tâche',
  noProjects: 'Aucun projet pour le moment',
  headerAssistant: 'Conversation de l’assistant',
  headerAssistantTask: 'Tâche de l’assistant',
  backToAssistant: 'Retour à l’assistant',
  statusCreated: 'Créée',
  statusRunning: 'En cours',
  statusWaitingApproval: 'En attente d’approbation',
  statusWaitingAnswer: 'En attente de réponse',
  statusDone: 'Terminée',
  statusFailed: 'Échouée',
  statusCancelled: 'Annulée',
  failureNotStarted: 'La tâche n’a jamais atteint de session d’exécution',
  failureInterrupted: 'La tâche a été interrompue au redémarrage de l’hôte',
  failureTurnError: 'L’exécution de la tâche a échoué',
  failureExecution: 'L’environnement d’exécution de la tâche est indisponible',
  failurePrompt: 'L’instruction de la tâche n’a pas pu être livrée',
  failureStore: 'L’enregistrement de la tâche n’a pas pu être écrit',
  failureQuota: 'L’assistant a atteint sa limite de tâches',
  failureScope: 'La tâche est hors du projet de cet assistant',
  failureNotAllowed: 'Cette conversation ne peut pas créer de tâches de l’assistant',
  failureUnknown: 'La tâche a échoué',
}

/** German assistant messages. */
export const de: AssistantLocale = {
  panel: 'Assistent',
  title: 'Assistent',
  selector: 'Assistent auswählen',
  global: 'Globaler Assistent',
  project: 'Projektassistent',
  tasks: 'Aufgaben',
  empty: 'Noch keine Aufgaben',
  open: 'Aufgabe öffnen',
  openAssistant: 'Assistenzgespräch öffnen',
  cancel: 'Aufgabe abbrechen',
  refresh: 'Aktualisieren',
  retry: 'Erneut versuchen',
  loading: 'Wird geladen',
  loadError: 'Die Assistentenaufgaben konnten nicht geladen werden',
  cancelError: 'Die Aufgabe konnte nicht abgebrochen werden',
  noProjects: 'Noch keine Projekte',
  headerAssistant: 'Assistenzgespräch',
  headerAssistantTask: 'Assistenzaufgabe',
  backToAssistant: 'Zurück zum Assistenten',
  statusCreated: 'Erstellt',
  statusRunning: 'Läuft',
  statusWaitingApproval: 'Wartet auf Freigabe',
  statusWaitingAnswer: 'Wartet auf Antwort',
  statusDone: 'Fertig',
  statusFailed: 'Fehlgeschlagen',
  statusCancelled: 'Abgebrochen',
  failureNotStarted: 'Die Aufgabe hat nie eine Ausführungssitzung erreicht',
  failureInterrupted: 'Die Aufgabe wurde beim Neustart des Hosts unterbrochen',
  failureTurnError: 'Die Aufgabenausführung ist fehlgeschlagen',
  failureExecution: 'Die Ausführungsumgebung der Aufgabe ist nicht verfügbar',
  failurePrompt: 'Die Aufgabenanweisung konnte nicht zugestellt werden',
  failureStore: 'Der Aufgabendatensatz konnte nicht geschrieben werden',
  failureQuota: 'Der Assistent hat sein Aufgabenlimit erreicht',
  failureScope: 'Die Aufgabe liegt außerhalb des Projekts dieses Assistenten',
  failureNotAllowed: 'Dieses Gespräch kann keine Assistenzaufgaben erstellen',
  failureUnknown: 'Die Aufgabe ist fehlgeschlagen',
}

/** Russian assistant messages. */
export const ru: AssistantLocale = {
  panel: 'Ассистент',
  title: 'Ассистент',
  selector: 'Выберите ассистента',
  global: 'Глобальный ассистент',
  project: 'Ассистент проекта',
  tasks: 'Задачи',
  empty: 'Задач пока нет',
  open: 'Открыть задачу',
  openAssistant: 'Открыть разговор ассистента',
  cancel: 'Отменить задачу',
  refresh: 'Обновить',
  retry: 'Повторить',
  loading: 'Загрузка',
  loadError: 'Не удалось загрузить задачи ассистента',
  cancelError: 'Не удалось отменить задачу',
  noProjects: 'Проектов пока нет',
  headerAssistant: 'Разговор ассистента',
  headerAssistantTask: 'Задача ассистента',
  backToAssistant: 'Вернуться к ассистенту',
  statusCreated: 'Создана',
  statusRunning: 'Выполняется',
  statusWaitingApproval: 'Ожидает одобрения',
  statusWaitingAnswer: 'Ожидает ответа',
  statusDone: 'Готово',
  statusFailed: 'Ошибка',
  statusCancelled: 'Отменена',
  failureNotStarted: 'Задача так и не получила сессию выполнения',
  failureInterrupted: 'Задача была прервана при перезапуске хоста',
  failureTurnError: 'Выполнение задачи завершилось ошибкой',
  failureExecution: 'Среда выполнения задачи недоступна',
  failurePrompt: 'Инструкция задачи не была доставлена',
  failureStore: 'Не удалось сохранить запись задачи',
  failureQuota: 'Ассистент достиг лимита задач',
  failureScope: 'Задача находится вне проекта этого ассистента',
  failureNotAllowed: 'Этот разговор не может создавать задачи ассистента',
  failureUnknown: 'Задача завершилась ошибкой',
}

/** Portuguese assistant messages. */
export const pt: AssistantLocale = {
  panel: 'Assistente',
  title: 'Assistente',
  selector: 'Escolher um assistente',
  global: 'Assistente global',
  project: 'Assistente do projeto',
  tasks: 'Tarefas',
  empty: 'Ainda não há tarefas',
  open: 'Abrir tarefa',
  openAssistant: 'Abrir a conversa do assistente',
  cancel: 'Cancelar tarefa',
  refresh: 'Atualizar',
  retry: 'Tentar novamente',
  loading: 'Carregando',
  loadError: 'Não foi possível carregar as tarefas do assistente',
  cancelError: 'Não foi possível cancelar a tarefa',
  noProjects: 'Ainda não há projetos',
  headerAssistant: 'Conversa do assistente',
  headerAssistantTask: 'Tarefa do assistente',
  backToAssistant: 'Voltar ao assistente',
  statusCreated: 'Criada',
  statusRunning: 'Em execução',
  statusWaitingApproval: 'Aguardando aprovação',
  statusWaitingAnswer: 'Aguardando resposta',
  statusDone: 'Concluída',
  statusFailed: 'Falhou',
  statusCancelled: 'Cancelada',
  failureNotStarted: 'A tarefa nunca chegou a uma sessão de execução',
  failureInterrupted: 'A tarefa foi interrompida quando o Host reiniciou',
  failureTurnError: 'A execução da tarefa falhou',
  failureExecution: 'O ambiente de execução da tarefa não está disponível',
  failurePrompt: 'A instrução da tarefa não pôde ser entregue',
  failureStore: 'O registro da tarefa não pôde ser gravado',
  failureQuota: 'O assistente atingiu o limite de tarefas',
  failureScope: 'A tarefa está fora do projeto deste assistente',
  failureNotAllowed: 'Esta conversa não pode criar tarefas do assistente',
  failureUnknown: 'A tarefa falhou',
}
