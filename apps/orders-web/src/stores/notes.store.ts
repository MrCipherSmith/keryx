import { action, computed, makeObservable, observable, runInAction } from "mobx";
import type { NoteDto, NotesApi } from "../api/notes.api";

export class NotesStore {
  @observable.ref notes: NoteDto[] = [];
  @observable loading = false;
  @observable saving = false;
  @observable error: string | null = null;

  private disposed = false;

  constructor(
    private readonly api: NotesApi,
    private readonly orderId: string,
  ) {
    makeObservable(this);
  }

  @computed get count(): number {
    return this.notes.length;
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.notes.length === 0;
  }

  onMount(): void {
    this.disposed = false;
    void this.loadNotes();
  }

  onUnmount(): void {
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
  }

  @action.bound
  refresh(): Promise<void> {
    return this.loadNotes();
  }

  @action.bound
  addNote(text: string): Promise<void> {
    return this.saveNote(text.trim());
  }

  private loadNotes = async (): Promise<void> => {
    runInAction(() => {
      this.loading = true;
      this.error = null;
    });
    try {
      const notes = await this.api.listNotes(this.orderId);
      runInAction(() => {
        if (this.disposed) return;
        this.notes = notes;
      });
    } catch (err: unknown) {
      runInAction(() => {
        if (this.disposed) return;
        this.error = err instanceof Error ? err.message : "Failed to load notes";
      });
    } finally {
      runInAction(() => {
        if (this.disposed) return;
        this.loading = false;
      });
    }
  };

  private saveNote = async (text: string): Promise<void> => {
    if (text.length === 0) return;
    runInAction(() => {
      this.saving = true;
      this.error = null;
    });
    try {
      const note = await this.api.addNote(this.orderId, text);
      runInAction(() => {
        if (this.disposed) return;
        this.notes = [note, ...this.notes];
      });
    } catch (err: unknown) {
      runInAction(() => {
        if (this.disposed) return;
        this.error = err instanceof Error ? err.message : "Failed to save the note";
      });
    } finally {
      runInAction(() => {
        if (this.disposed) return;
        this.saving = false;
      });
    }
  };
}
