/**
 * The memory browser's state: the Host's banks, the selected bank's statistics,
 * knowledge pages, and memory units, the page body open beside them, the search
 * over the knowledge index, and the two writes a person performs — recording a
 * finding and curating an existing one. Every fact comes from the Host; the
 * store never talks to the daemon itself.
 *
 * An unavailable Host is a first-class state rather than an error: a deployment
 * that ships no memory provider has nothing to browse, and the page says so
 * with the reason the Host classified instead of showing a blank panel. The
 * same holds per section: a provider that curates no knowledge pages leaves
 * that section saying so, while the rest of the bank keeps rendering.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  MemoryAnswer,
  MemoryBankStats,
  MemoryBankSummary,
  MemoryKnowledgeHit,
  MemoryKnowledgePage,
  MemoryKnowledgePageBody,
  MemoryUnitSummary,
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

/** The add-memory form's draft while it is open. */
export interface MemoryAddDraft {
  readonly text: string
  readonly context: string
}

/** The curate form's draft while it is open over one unit. */
export interface MemoryEditDraft {
  readonly unitId: string
  readonly text: string
  readonly context: string
  readonly factType: string
}

/**
 * What the last write did, as the page words it. A refused write keeps its
 * form open and carries the backend's own detail; an accepted one closes the
 * form and refreshes the bank.
 */
export type MemoryWriteNote =
  | { readonly kind: 'remembered'; readonly detail: string }
  | { readonly kind: 'curated'; readonly detail: string }
  | { readonly kind: 'refused'; readonly detail: string }

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
  /** Why the statistics section cannot render, when it cannot. */
  readonly statsProblem: MemoryPanelProblem | null
  readonly pages: readonly MemoryKnowledgePage[]
  /** Why the knowledge-page section cannot render, when it cannot. */
  readonly pagesProblem: MemoryPanelProblem | null
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
  /** The selected bank's memory units for the current filter and page. */
  readonly units: readonly MemoryUnitSummary[]
  /** Total units the backend holds for the current filter, which may exceed `units.length`. */
  readonly unitsTotal: number
  /** The page size the Host answered with, so pagination agrees with it. */
  readonly unitsLimit: number
  /** Zero-based index of the first unit on screen. */
  readonly unitsOffset: number
  /** The committed unit filter; an empty string lists every unit. */
  readonly unitQuery: string
  /** The filter box's current text, applied on submit. */
  readonly unitQueryDraft: string
  /** Whether the units page is being read. */
  readonly unitsLoading: boolean
  /** Why the units section cannot render, when it cannot. */
  readonly unitsProblem: MemoryPanelProblem | null
  /** The add-memory form's draft, or null when the form is closed. */
  readonly addDraft: MemoryAddDraft | null
  /** The curate form's draft, or null when no unit is being edited. */
  readonly editDraft: MemoryEditDraft | null
  /** Whether a write call is in flight. */
  readonly writing: boolean
  /** Why the last write could not be issued, when it could not. */
  readonly writeProblem: MemoryPanelProblem | null
  /** What the last write did, when it completed. */
  readonly writeNote: MemoryWriteNote | null
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
  /** Type into the unit filter box; the list stays until the filter runs. */
  editUnitQuery: (text: string) => void
  /** Apply the unit filter from the first page. */
  runUnitFilter: () => void
  /** Read another page of units. */
  pageUnits: (offset: number) => void
  /** Open the add-memory form. */
  startAdd: () => void
  /** Edit the add-memory draft. */
  editAdd: (field: 'text' | 'context', value: string) => void
  /** Record the drafted finding. */
  submitAdd: () => void
  /** Close the add-memory form, discarding the draft. */
  cancelAdd: () => void
  /** Open the curate form over one unit. */
  startEdit: (unit: MemoryUnitSummary) => void
  /** Edit the curate draft. */
  editCurate: (field: 'text' | 'context' | 'factType', value: string) => void
  /** Submit the curation. */
  submitEdit: () => void
  /** Close the curate form, discarding the draft. */
  cancelEdit: () => void
  /** Forget the last write's outcome note. */
  dismissWriteNote: () => void
  /** Forget the recorded failure so the page can try again. */
  dismissProblem: () => void
}

/** What both write payloads carry: whether the backend accepted, and its detail. */
interface WriteOutcome {
  readonly remembered?: boolean
  readonly curated?: boolean
  readonly detail?: string
}

/** A write answer as the generated client settles it. */
type WriteAnswer =
  | { readonly ok: true; readonly value: MemoryAnswer<WriteOutcome> }
  | { readonly ok: false; readonly error: { readonly message: string } }

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
  statsProblem: null,
  pages: [],
  pagesProblem: null,
  openPage: null,
  pageLoading: false,
  query: '',
  searching: false,
  hits: [],
  total: 0,
  searchProblem: null,
  units: [],
  unitsTotal: 0,
  unitsLimit: 0,
  unitsOffset: 0,
  unitQuery: '',
  unitQueryDraft: '',
  unitsLoading: false,
  unitsProblem: null,
  addDraft: null,
  editDraft: null,
  writing: false,
  writeProblem: null,
  writeNote: null,
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
          statsProblem: null,
          pages: [],
          pagesProblem: null,
          openPage: null,
          pageLoading: false,
          hits: [],
          total: 0,
          searchProblem: null,
          units: [],
          unitsTotal: 0,
          unitsOffset: 0,
          unitsLoading: false,
          unitsProblem: null,
          addDraft: null,
          editDraft: null,
          writing: false,
          writeNote: null,
          writeProblem: null,
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
      editUnitQuery: (text) => { if (this.getSnapshot().unitQueryDraft !== text) this.patch({ unitQueryDraft: text }) },
      runUnitFilter: () => {
        const { bankId, unitQueryDraft, unitQuery, unitsOffset } = this.getSnapshot()
        if (bankId === null || (unitQueryDraft.trim() === unitQuery && unitsOffset === 0)) return
        this.patch({ unitQuery: unitQueryDraft.trim(), unitsOffset: 0 })
        void this.readUnits(bankId)
      },
      pageUnits: (offset) => {
        const { bankId, unitsOffset } = this.getSnapshot()
        if (bankId === null || offset === unitsOffset) return
        this.patch({ unitsOffset: offset })
        void this.readUnits(bankId)
      },
      startAdd: () => {
        if (this.getSnapshot().addDraft !== null) return
        this.patch({ addDraft: { text: '', context: '' }, editDraft: null, writeNote: null, writeProblem: null })
      },
      editAdd: (field, value) => {
        const draft = this.getSnapshot().addDraft
        if (draft === null) return
        this.patch({ addDraft: { ...draft, [field]: value } })
      },
      submitAdd: () => { void this.remember() },
      cancelAdd: () => { this.patch({ addDraft: null }) },
      startEdit: (unit) => {
        this.patch({
          editDraft: {
            unitId: unit.id,
            text: unit.text,
            context: unit.context ?? '',
            factType: unit.factType ?? '',
          },
          addDraft: null,
          writeNote: null,
          writeProblem: null,
        })
      },
      editCurate: (field, value) => {
        const draft = this.getSnapshot().editDraft
        if (draft === null) return
        this.patch({ editDraft: { ...draft, [field]: value } })
      },
      submitEdit: () => { void this.curate() },
      cancelEdit: () => { this.patch({ editDraft: null }) },
      dismissWriteNote: () => { if (this.getSnapshot().writeNote !== null) this.patch({ writeNote: null }) },
      dismissProblem: () => { if (this.getSnapshot().problem !== null) this.patch({ problem: null }) },
    }
  }

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
   * Read one bank's statistics, page tree, and memory units. The three are
   * separate Remote methods, so one failing leaves the others standing: a bank
   * whose statistics the daemon cannot measure still lists its units, and a
   * provider that curates no knowledge pages leaves that section saying so. A
   * failed half keeps whatever was on screen rather than clearing a working
   * view.
   * @param bankId - the bank to read.
   * @returns settlement after the reads are reflected.
   */
  private async loadBank(bankId: string): Promise<void> {
    this.patch({ loading: 'bank', statsProblem: null, pagesProblem: null, unitsProblem: null })
    await Promise.all([
      this.readStats(bankId),
      this.readPages(bankId),
      this.readUnits(bankId),
    ])
    if (this.disposed || this.getSnapshot().bankId !== bankId) return
    this.patch({ loading: 'none' })
  }

  /**
   * Read one bank's statistics. A provider that measures none answers
   * unsupported, which this section keeps as its own problem rather than
   * hiding the section without a word.
   * @param bankId - the bank to read.
   * @returns settlement after the read is reflected.
   */
  private async readStats(bankId: string): Promise<void> {
    const answer = await this.ctx.remote.memoryController.stats(bankId)
    if (this.disposed || this.getSnapshot().bankId !== bankId) return
    if (!answer.ok) {
      this.patch({ stats: null, statsProblem: failedAnswer(answer.error) })
      return
    }
    if (!answer.value.available) {
      this.patch({ stats: null, statsProblem: problemOf(answer.value) })
      return
    }
    this.patch({ stats: answer.value.stats ?? null, statsProblem: null })
  }

  /**
   * Read one bank's knowledge-page tree.
   * @param bankId - the bank to read.
   * @returns settlement after the read is reflected.
   */
  private async readPages(bankId: string): Promise<void> {
    const answer = await this.ctx.remote.memoryController.pages(bankId)
    if (this.disposed || this.getSnapshot().bankId !== bankId) return
    if (!answer.ok) {
      this.patch({ pages: [], pagesProblem: failedAnswer(answer.error) })
      return
    }
    if (!answer.value.available) {
      this.patch({ pages: [], pagesProblem: problemOf(answer.value) })
      return
    }
    this.patch({ pages: answer.value.pages, pagesProblem: null })
  }

  /**
   * Read one page of the bank's memory units under the committed filter. The
   * page size is the Host's, returned with the page, so the pagination controls
   * and the listing always agree about where one page ends.
   * @param bankId - the bank to read.
   * @returns settlement after the read is reflected.
   */
  private async readUnits(bankId: string): Promise<void> {
    const { unitQuery, unitsOffset } = this.getSnapshot()
    this.patch({ unitsLoading: true, unitsProblem: null })
    const answer = await this.ctx.remote.memoryController.units(bankId, unitQuery, undefined, undefined, unitsOffset)
    if (this.disposed || this.getSnapshot().bankId !== bankId) return
    if (!answer.ok) {
      this.patch({ unitsLoading: false, unitsProblem: failedAnswer(answer.error) })
      return
    }
    if (!answer.value.available) {
      this.patch({ unitsLoading: false, unitsProblem: problemOf(answer.value) })
      return
    }
    this.patch({
      unitsLoading: false,
      units: answer.value.units,
      unitsTotal: answer.value.total,
      unitsLimit: answer.value.limit,
      unitsOffset: answer.value.offset,
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

  /**
   * Record the drafted finding. Retention is asynchronous on backends that
   * extract facts by inference, so an accepted write closes the form, notes
   * the outcome, and refreshes the bank — the unit becomes listable once the
   * backend finishes extracting it. A refused write keeps the form open with
   * the backend's own detail.
   * @returns settlement after the outcome is reflected.
   */
  private async remember(): Promise<void> {
    const { bankId, addDraft } = this.getSnapshot()
    if (bankId === null || addDraft === null || this.getSnapshot().writing) return
    const text = addDraft.text.trim()
    if (text.length === 0) return
    const context = addDraft.context.trim()
    await this.write(
      bankId,
      () => this.ctx.remote.memoryController.remember(
        bankId,
        text,
        context.length === 0 ? undefined : context,
      ),
      outcome => outcome.remembered === true,
      'remembered',
      { addDraft: null },
    )
  }

  /**
   * Submit the curation draft. The draft is authoritative: every field is sent,
   * so clearing the context box clears the context. An accepted curation
   * closes the form and refreshes the units; a refused one keeps the form open
   * with the backend's detail.
   * @returns settlement after the outcome is reflected.
   */
  private async curate(): Promise<void> {
    const { bankId, editDraft } = this.getSnapshot()
    if (bankId === null || editDraft === null || this.getSnapshot().writing) return
    const text = editDraft.text.trim()
    if (text.length === 0) return
    await this.write(
      bankId,
      () => this.ctx.remote.memoryController.curate(
        bankId,
        editDraft.unitId,
        text,
        editDraft.context.trim(),
        editDraft.factType.trim(),
      ),
      outcome => outcome.curated === true,
      'curated',
      { editDraft: null },
    )
  }

  /**
   * Issue one write and settle it. Both writes share their failure halves — a
   * call that never answered, and one the Host classified — and both refresh
   * the bank on acceptance so the new fact count and the new or curated unit
   * show up without a manual refresh. They differ only in the call, how
   * acceptance reads, the note they leave, and the draft they close.
   * @param bankId - the bank being written to.
   * @param call - issues the Remote write.
   * @param accepted - whether the answered outcome landed the write.
   * @param kind - the note an accepted write leaves.
   * @param closeDraft - the state patch that closes the write's form.
   * @returns settlement after the outcome is reflected.
   */
  private async write(
    bankId: string,
    call: () => Promise<WriteAnswer>,
    accepted: (outcome: WriteOutcome) => boolean,
    kind: 'remembered' | 'curated',
    closeDraft: Partial<MemoryBrowserState>,
  ): Promise<void> {
    this.patch({ writing: true, writeProblem: null, writeNote: null })
    const answer = await call()
    if (this.disposed || this.getSnapshot().bankId !== bankId) return
    if (!answer.ok) {
      this.patch({ writing: false, writeProblem: failedAnswer(answer.error) })
      return
    }
    if (!answer.value.available) {
      this.patch({ writing: false, writeProblem: problemOf(answer.value) })
      return
    }
    const detail = answer.value.detail ?? ''
    if (!accepted(answer.value)) {
      this.patch({ writing: false, writeNote: { kind: 'refused', detail } })
      return
    }
    this.patch({ ...closeDraft, writing: false, writeNote: { kind, detail } })
    void this.load()
  }

  private patch(next: Partial<MemoryBrowserState>): void {
    if (this.disposed) return
    this.store.set({ ...this.getSnapshot(), ...next })
  }
}

export default MemoryBrowserController
