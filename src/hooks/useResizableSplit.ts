import { useState, useRef, useCallback, useEffect } from 'react';

export interface UseResizableSplitOptions {
  initialRatio?: number; // 0.0 - 1.0 (デフォルト: 0.5)
  direction?: 'horizontal' | 'vertical'; // デフォルト: 'horizontal' (左右分割)
  minRatio?: number; // デフォルト: 0.15
  maxRatio?: number; // デフォルト: 0.85
  storageKey?: string; // localStorage に比率を保存する場合のキー
}

export function useResizableSplit(options: UseResizableSplitOptions = {}) {
  const {
    initialRatio = 0.5,
    direction = 'horizontal',
    minRatio = 0.15,
    maxRatio = 0.85,
    storageKey
  } = options;

  const [ratio, setRatioState] = useState<number>(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= minRatio && parsed <= maxRatio) {
          return parsed;
        }
      }
    }
    return initialRatio;
  });

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const setRatio = useCallback((newRatio: number) => {
    const clamped = Math.max(minRatio, Math.min(maxRatio, newRatio));
    setRatioState(clamped);
    if (storageKey) {
      localStorage.setItem(storageKey, clamped.toString());
    }
  }, [minRatio, maxRatio, storageKey]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
  }, [direction]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      let newRatio = ratio;

      if (direction === 'horizontal') {
        const mouseX = e.clientX - rect.left;
        newRatio = mouseX / rect.width;
      } else {
        const mouseY = e.clientY - rect.top;
        newRatio = mouseY / rect.height;
      }

      setRatio(newRatio);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDragging, direction, ratio, setRatio]);

  return {
    ratio,
    setRatio,
    isDragging,
    containerRef,
    resizerProps: {
      onMouseDown: handleMouseDown
    }
  };
}
