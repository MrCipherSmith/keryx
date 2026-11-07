import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui';

/** The same route keeps list state mounted while a narrow screen shows details. */
export function RecordBrowser({
  selectedId,
  list,
  detail,
  onBack,
  listOnly = false,
}: {
  selectedId?: string;
  list: ReactNode;
  detail: ReactNode;
  onBack: () => void;
  listOnly?: boolean;
}) {
  const { t } = useTranslation('context');
  const detailPane = useRef<HTMLDivElement>(null);
  const beforeOpen = useRef<{ scrollY: number; target: HTMLElement } | null>(null);

  useLayoutEffect(() => {
    if (!listOnly && !window.matchMedia?.('(width < 80rem)').matches) return;
    if (selectedId) {
      detailPane.current?.focus({ preventScroll: true });
      detailPane.current?.scrollIntoView?.({ block: 'start' });
      return;
    }
    const previous = beforeOpen.current;
    if (previous) {
      previous.target.focus({ preventScroll: true });
      window.scrollTo({ top: previous.scrollY });
      beforeOpen.current = null;
    }
  }, [selectedId, listOnly]);

  return (
    <div className={listOnly ? "document-browser grid min-w-0" : "mt-6 grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]"}>
      <div
        className={selectedId ? listOnly ? 'hidden' : 'hidden min-w-0 xl:block' : 'min-w-0'}
        onClickCapture={(event) => {
          const button = (event.target as HTMLElement).closest('button[data-record-open]');
          if (button instanceof HTMLElement) {
            beforeOpen.current = { scrollY: window.scrollY, target: button };
          }
        }}
      >
        {list}
      </div>
      <div
        ref={detailPane}
        tabIndex={selectedId ? -1 : undefined}
        className={selectedId ? 'min-w-0 scroll-mt-24 outline-none' : listOnly ? 'hidden' : 'hidden min-w-0 xl:block'}
      >
        {selectedId && <div className={listOnly ? "document-back-bar" : "mb-4 xl:hidden"}>
          <Button variant="secondary" onClick={onBack}>← {t('backToList')}</Button>
        </div>}
        {detail}
      </div>
    </div>
  );
}
