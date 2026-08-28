'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

export default function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100, 200],
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  // Generate page numbers to show
  const getPages = () => {
    const pages: (number | '...')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push('...');
      for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
      if (page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-border">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {total === 0 ? 'No results' : `${start}–${end} of ${total}`}
        </span>
        {onPageSizeChange && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Rows:</span>
            <select
              value={pageSize}
              onChange={e => { onPageSizeChange(Number(e.target.value)); onPageChange(1); }}
              className="text-xs border border-border rounded px-2 py-1 focus:outline-none bg-white"
            >
              {pageSizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1">
        <PageBtn onClick={() => onPageChange(1)} disabled={page === 1} title="First page">
          <ChevronsLeft className="w-3.5 h-3.5" />
        </PageBtn>
        <PageBtn onClick={() => onPageChange(page - 1)} disabled={page === 1} title="Previous page">
          <ChevronLeft className="w-3.5 h-3.5" />
        </PageBtn>

        {getPages().map((p, i) =>
          p === '...' ? (
            <span key={`ellipsis-${i}`} className="w-8 text-center text-xs text-muted-foreground">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p as number)}
              className={`w-8 h-8 rounded-lg text-xs font-medium transition ${
                p === page
                  ? 'bg-blue-600 text-white'
                  : 'hover:bg-muted text-foreground'
              }`}
            >
              {p}
            </button>
          )
        )}

        <PageBtn onClick={() => onPageChange(page + 1)} disabled={page === totalPages} title="Next page">
          <ChevronRight className="w-3.5 h-3.5" />
        </PageBtn>
        <PageBtn onClick={() => onPageChange(totalPages)} disabled={page === totalPages} title="Last page">
          <ChevronsRight className="w-3.5 h-3.5" />
        </PageBtn>
      </div>
    </div>
  );
}

function PageBtn({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled: boolean; title: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-muted transition disabled:opacity-30 disabled:cursor-not-allowed text-foreground"
    >
      {children}
    </button>
  );
}
