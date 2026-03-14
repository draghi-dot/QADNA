import { memo } from 'react';

export default memo(({ data }) => {
  return (
    <div className="w-full h-full relative">
      <div className="absolute -top-6 left-4 text-zinc-400 font-bold tracking-widest text-sm uppercase">
        {data.label}
      </div>
    </div>
  );
});
