import { memo } from 'react';

export default memo(({ data }) => {
  return (
    <div className="w-full h-full relative">
      <div
        className="absolute -top-6 left-4 text-xs font-bold tracking-widest uppercase"
        style={{ color: '#7a7a8a', fontFamily: 'Inter, -apple-system, sans-serif' }}
      >
        {data.label}
      </div>
    </div>
  );
});
