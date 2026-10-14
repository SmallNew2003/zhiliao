/**
 * The memory browser's state: the Host's banks, the selected bank's statistics
 * and knowledge pages, the page body open beside them, and the search over the
 * knowledge index. Every fact comes from the Host — the store re-reads after a
 * bank switch and after every manual refresh, and it never retains or edits a
 * memory itself.
 *
 * An unavailable Host is a first-class state rather than an error: a deployment
 * that ships no memory provider has nothing to browse, and the page says so
 * with the reason the Host classified instead of showing a blank panel.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  MemoryAnswer,
  MemoryBankStats,
  MemoryBankSummary,
  MemoryKnowledgeHit,
  MemoryKnowledgePage,
  MemoryKnowledgePageBody,
  MemoryUnavailableReason,
} from '@deepseek-ai/dsh-host-memory-controller/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * Why the panel cannot show memory, as the page renders it: the Host's own
 * classification, or the transport's refusal to deliver an answer at all.
 */
export type MemoryPanelProblem =
  | {
    /** The Host answered, and named the condition it hit. */
    readonly kind: 'unavailable'
    readonly reason: MemoryUnavailableReason
    readonly detail: string
  }
  | {
    /** The call never produced an answer: the socket, the codec, or the Host itself failed. */
    readonly kind: 'error'
    readonly detail: string
  }

/** How much of a bank the panel is currently loading. */
export type MemoryLoadScope = 'none' | 'banks' | 'bank'

/** What the page renders. */
export interface MemoryBrowserState {
  /** `unavailable` keeps the last banks; `error` is a failed read the page retries. */
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  /** Why the panel cannot show memory, when it cannot. */
  readonly problem: MemoryPanelProblem | null
  readonly banks: readonly MemoryBankSummary[]
  /** The bank whose statistics and pages are loaded, or null before one is picked. */
  readonly bankId: string | null
  /** Which read is in flight; `none` when nothing crosses the wire. */
  readonly loading: MemoryLoadScope
  /** The selected bank's statistics, absent until the Host answers with them. */
  readonly stats: MemoryBankStats | null
  readonly pages: readonly MemoryKnowledgePage[]
  /** The knowledge page open over the bank, with its body. */
  readonly openPage: MemoryKnowledgePageBody | null
  /** Whether the open page's body is still being read. */
  readonly pageLoading: boolean
  /** The search box's current text. */
  readonly query: string
  /** Whether a search is in flight. */
  readonly searching: boolean
  /** The last search's hits. */
  readonly hits: readonly MemoryKnowledgeHit[]
  /** The last search's total, which may exceed `hits.length`. */
  readonly total: number
  /** Why the last search produced nothing, when it failed. */
  readonly searchProblem: MemoryPanelProblem | null
}

/** The registration-side face the panel's slot entry injects. */
export interface MemoryBrowserFace {
  hooks: {
    /** Panel snapshot bound by the renderer as useMemoryBrowser. */
    memoryBrowser: SnapshotStore<MemoryBrowserState>
  }
  /** Read the Host once the panel first renders. */
  ensure: () => void
  /** Read the banks again, and the selected bank's detail with them. */
  refresh: () => void
  /** Switch to another bank, dropping the previous bank's detail and search. */
  selectBank: (bankId: string) => void
  /** Type into the search box; the hits stay until a search runs. */
  editQuery: (text: string) => void
  /** Search the selected bank's knowledge index. */
  runSearch: () => void
  /** Open a knowledge page over the bank. */
  openPage: (pageId: string) => void
  /** Close the open page. */
  closePage: () => void
  /** Forget the recorded failure so the page can try again. */
  dismissProblem: () => void
}

/** Read the unavailable half of an answer as the panel's problem. */
function problemOf(value: Extract<MemoryAnswer<unknown>, { available: false }>): MemoryPanelProblem {
  return { kind: 'unavailable', reason: value.reason, detail: value.detail }
}

/**
 * Read a failed call as the panel's problem.
 * @param error - the generated client's refusal, carrying the transport's words.
 * @returns the transport-half problem.
 */
function failedAnswer(error: { readonly message: string }): MemoryPanelProblem {
  return { kind: 'error', detail: error.message }
}

/** The state a panel opens on: nothing read, nothing selected. */
const IDLE: MemoryBrowserState = {
  status: 'idle',
  problem: null,
  banks: [],
  bankId: null,
  loading: 'none',
  stats: null,
  pages: [],
  openPage: null,
  pageLoading: false,
  query: '',
  searching: false,
  hits: [],
  total: 0,
  searchProblem: null,
}

/**
 * The order the list shows banks in: the most recently written first, so the
 * bank a session has been writing to is the one a person sees at the top, and
 * never-written banks sink to the bottom rather than disappearing.
 * @param banks - the Host's banks as summaries.
 * @returns the summaries ordered by last write, descending.
 */
export function sortBanks(banks: readonly MemoryBankSummary[]): MemoryBankSummary[] {
  return [...banks].sort((left, right) => {
    // A bank with no write has no instant to compare, so it ranks after every
    // bank that has one and among its peers by name.
    if (left.lastWriteAt === undefined || right.lastWriteAt === undefined) {
      if (left.lastWriteAt !== right.lastWriteAt) return left.lastWriteAt === undefined ? 1 : -1
      return left.name.localeCompare(right.name)
    }
    return right.lastWriteAt.localeCompare(left.lastWriteAt) || left.name.localeCompare(right.name)
  })
}

/** Reads the Host's memory browse surface through the `memoryController` Remote. */
export class MemoryBrowserController {
  private readonly store: SnapshotStore<MemoryBrowserState>
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0
  private disposed = false

  /**
   * @param ctx - the panel plugin's context, whose `remote.memoryController` namespace answers.
   */
  constructor(private readonly ctx: ClientContext) {
    this.store = createSnapshotStore<MemoryBrowserState>(IDLE)
  }

  /**
   * Read the panel's state.
   * @returns the current sync snapshot (stable reference until the next change).
   */
  getSnapshot(): MemoryBrowserState {
    return this.store.getSnapshot()
  }

  /** Stop publishing and drop every late settlement. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
  }

  /**
   * Build the face the panel's slot registration injects.
   * @returns the panel's snapshot source and its actions.
   */
  inject(): MemoryBrowserFace {
    return {
      hooks: { memoryBrowser: this.store },
      ensure: () => { if (this.getSnapshot().status === 'idle') void this.load() },
      refresh: () => { void this.load() },
      selectBank: (bankId) => {
        const state = this.getSnapshot()
        if (state.bankId === bankId || state.loading === 'banks') return
        this.patch({
          bankId,
          stats: null,
          pages: [],
          openPage: null,
          pageLoading: false,
          hits: [],
          total: 0,
          searchProblem: null,
        })
        void this.loadBank(bankId)
      },
      editQuery: (text) => { if (this.getSnapshot().query !== text) this.patch({ query: text }) },
      runSearch: () => { void this.search() },
      openPage: (pageId) => {
        const bankId = this.getSnapshot().bankId
        if (bankId === null || this.getSnapshot().pageLoading) return
        this.patch({ openPage: null, pageLoading: true })
        void this.readPage(bankId, pageId)
      },
      closePage: () => {
        if (this.getSnapshot().openPage !== null || this.getSnapshot().pageLoading) {
          this.patch({ openPage: null, pageLoading: false })
        }
      },
      dismissProblem: () => { if (this.getSnapshot().problem !== null) this.patch({ problem: null }) },
    }
  }

  /* jscpd:ignore-start — independent owners: this controller and ui-plugin-manager's
     manager-store each own their read surface (banks versus bundles) and their own
     disposal, so the in-flight merge stays target-local until a third controller needs
     the same skeleton. */
  /**
   * Read the banks, then the selected bank's detail. A call during an in-flight
   * read marks one rerun after it settles, so a refresh during a slow load does
   * not read the daemon twice for the same answer.
   * @returns settlement after this call's freshness is reflected.
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    const run = Promise.resolve().then(() => this.read())
    this.inFlight = run
    return run
  }
  /* jscpd:ignore-end */

  /**
   * Read the pending rerun flag, clearing it.
   *
   * `load()` sets the flag from outside this loop, between the loop's own reads, so the
   * check has to go through a call the type checker cannot narrow to a stale constant.
   * @returns whether another read was requested while the current one was in flight.
   */
  private rerunRequested(): boolean {
    const requested = this.rerun
    this.rerun = false
    return requested
  }

  private async read(): Promise<void> {
    try {
      do {
        this.rerun = false
        const generation = ++this.generation
        if (this.getSnapshot().status === 'idle') this.patch({ status: 'loading', loading: 'banks' })
        const answer = await this.ctx.remote.memoryController.list()
        if (generation !== this.generation) return
        if (!answer.ok) {
          this.patch({ status: 'error', problem: failedAnswer(answer.error), loading: 'none' })
          continue
        }
        if (!answer.value.available) {
          // The banks already on screen stay: a daemon that went away does not
          // erase what the panel was showing a moment ago.
          this.patch({ status: 'unavailable', problem: problemOf(answer.value), loading: 'none' })
          continue
        }
        const banks = sortBanks(answer.value.banks)
        // The selected bank survives a refresh only while the Host still has it;
        // otherwise the first bank is selected so the panel is never bankless.
        const previous = this.getSnapshot().bankId
        const bankId = banks.some(bank => bank.bankId === previous) ? previous : (banks[0]?.bankId ?? null)
        this.patch({ status: 'ready', problem: null, banks, bankId, loading: 'none' })
        if (bankId !== null) await this.loadBank(bankId)
      } while (this.rerunRequested())
    } finally {
      this.inFlight = undefined
    }
  }

  /**
   * Read one bank's statistics and page tree. Statistics and pages are separate
   * Remote methods, so one failing leaves the other standing: a bank whose
   * statistics the daemon cannot measure still lists its pages. A failed half
   * keeps whatever was on screen rather than clearing a working view.
   * @param bankId - the bank to read.
   * @returns settlement after both reads are reflected.
   */
  private async loadBank(bankId: string): Promise<void> {
    this.patch({ loading: 'bank' })
    const [stats, pages] = await Promise.all([
      this.ctx.remote.memoryController.stats(bankId),
      this.ctx.remote.memoryController.pages(bankId),
    ])
    if (this.disposed || this.getSnapshot().bankId !== bankId) return
    this.patch({
      loading: 'none',
      ...stats.ok && stats.value.available ? { stats: stats.value.stats ?? null } : {},
      ...pages.ok && pages.value.available ? { pages: pages.value.pages } : {},
    })
  }

  /**
   * Search the selected bank's knowledge index. A blank query is not a search:
   * it would ask the daemon to match everything and answer with its own idea of
   * the best twenty pages, which is not what an empty box means to a person.
   */
  private async search(): Promise<void> {
    const { bankId, query } = this.getSnapshot()
    if (bankId === null || this.getSnapshot().searching) return
    const trimmed = query.trim()
    if (trimmed === '') {
      this.patch({ hits: [], total: 0, searchProblem: null })
      return
    }
    this.patch({ searching: true, searchProblem: null })
    const answer = await this.ctx.remote.memoryController.search(bankId, trimmed, undefined)
    if (this.disposed || this.getSnapshot().bankId !== bankId) return
    if (!answer.ok) {
      this.patch({ searching: false, hits: [], total: 0, searchProblem: failedAnswer(answer.error) })
      return
    }
    if (!answer.value.available) {
      this.patch({ searching: false, hits: [], total: 0, searchProblem: problemOf(answer.value) })
      return
    }
    this.patch({ searching: false, hits: answer.value.hits, total: answer.value.total })
  }

  /**
   * Read one knowledge page's body over the bank. A page the backend has no
   * body for closes the reader rather than leaving an empty panel open.
   * @param bankId - the bank owning the page.
   * @param pageId - the page to read.
   * @returns settlement after the body is reflected.
   */
  private async readPage(bankId: string, pageId: string): Promise<void> {
    const answer = await this.ctx.remote.memoryController.page(bankId, pageId)
    if (this.disposed || this.getSnapshot().bankId !== bankId || !this.getSnapshot().pageLoading) return
    if (!answer.ok) {
      this.patch({ pageLoading: false, problem: failedAnswer(answer.error) })
      return
    }
    if (!answer.value.available) {
      this.patch({ pageLoading: false, openPage: null, problem: problemOf(answer.value) })
      return
    }
    this.patch({ pageLoading: false, openPage: answer.value.page ?? null })
  }

  private patch(next: Partial<MemoryBrowserState>): void {
    if (this.disposed) return
    this.store.set({ ...this.getSnapshot(), ...next })
  }
}

export default MemoryBrowserController
