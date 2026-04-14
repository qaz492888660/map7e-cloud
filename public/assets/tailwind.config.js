window.tailwind = window.tailwind || {}
window.tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        body: ['"Manrope"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Sora"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  safelist: [
    'bg-cyan-100/80',
    'bg-sky-100/80',
    'bg-blue-100/80',
    'bg-teal-100/80',
    'from-cyan-200/80',
    'via-sky-200/65',
    'to-blue-300/70',
    'from-sky-200/80',
    'via-blue-200/65',
    'to-indigo-300/70',
    'from-blue-200/80',
    'via-indigo-200/65',
    'to-violet-300/70',
    'from-teal-200/80',
    'via-cyan-200/65',
    'to-sky-300/70',
    'bg-white/10',
    'text-blue-100',
    'bg-cyan-200/[0.15]',
    'text-cyan-50',
    'bg-emerald-200/[0.15]',
    'text-emerald-50',
    'bg-indigo-200/20',
    'text-indigo-50',
    'bg-slate-200/[0.14]',
    'text-slate-50',
  ],
}
