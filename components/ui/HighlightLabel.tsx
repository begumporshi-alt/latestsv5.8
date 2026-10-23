'use client';

import { tokenizeSearch } from '@/lib/search';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Renders text with the query's tokens visually marked (shared by global + form search results). */
export default function HighlightLabel({ text, query }: { text: string; query: string }) {
  const tokens = tokenizeSearch(query);
  if (!tokens.length) return <>{text}</>;
  const re = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'ig');
  return (
    <>
      {text.split(re).map((part, i) =>
        tokens.includes(part.toLowerCase())
          ? <mark key={i} className="bg-blue-100 text-blue-700 rounded-sm px-0.5">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}
