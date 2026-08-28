'use client';

import { useState, useEffect, useCallback } from 'react';

export interface GlobalCartItem {
  id: string;
  name: string;
  sku: string;
  unit_price: number;
  quantity: number;
  selected_unit?: { id: string; unit_name: string; unit_short: string } | null;
  image_url?: string | null;
}

const STORAGE_KEY = 'pos-global-cart';
const EVENT_NAME = 'pos-global-cart-update';

function readStorage(): GlobalCartItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeStorage(items: GlobalCartItem[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function useGlobalCart() {
  const [items, setItems] = useState<GlobalCartItem[]>(readStorage);

  useEffect(() => {
    function handler() { setItems(readStorage()); }
    window.addEventListener(EVENT_NAME, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(EVENT_NAME, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const addToCart = useCallback((item: GlobalCartItem) => {
    const current = readStorage();
    const existingIdx = current.findIndex(
      i => i.id === item.id && i.selected_unit?.id === item.selected_unit?.id
    );
    if (existingIdx >= 0) {
      current[existingIdx].quantity += item.quantity || 1;
    } else {
      current.push({ ...item, quantity: item.quantity || 1 });
    }
    writeStorage(current);
  }, []);

  const clearCart = useCallback(() => {
    writeStorage([]);
  }, []);

  const count = items.reduce((sum, i) => sum + i.quantity, 0);

  return { items, count, addToCart, clearCart };
}
