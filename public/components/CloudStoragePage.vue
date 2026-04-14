<script setup>
import { computed, onMounted, ref } from 'vue'

const summaryThemes = [
  {
    accent: 'from-cyan-200/80 via-sky-200/65 to-blue-300/70',
    iconBg: 'bg-cyan-100/80',
  },
  {
    accent: 'from-sky-200/80 via-blue-200/65 to-indigo-300/70',
    iconBg: 'bg-sky-100/80',
  },
  {
    accent: 'from-blue-200/80 via-indigo-200/65 to-violet-300/70',
    iconBg: 'bg-blue-100/80',
  },
  {
    accent: 'from-teal-200/80 via-cyan-200/65 to-sky-300/70',
    iconBg: 'bg-teal-100/80',
  },
]

const panelVisible = ref(false)
const search = ref('')
const files = ref([])
const manifestTitle = ref('Map7e Cloud Resource Library')
const manifestUpdatedAt = ref('')
const loadingManifest = ref(false)
const errorMessage = ref('')

const bubbleSpecs = [
  { id: 'b1', size: 22, left: '4%', bottom: '-10%', duration: '34s', delay: '0s', opacity: 0.13, blur: 0.3, driftA: '10px', driftB: '-14px', driftC: '8px', scaleStart: 0.76, scaleMid: 0.92, scaleEnd: 1.02 },
  { id: 'b2', size: 30, left: '9%', bottom: '-18%', duration: '39s', delay: '4s', opacity: 0.16, blur: 0.4, driftA: '16px', driftB: '-10px', driftC: '14px', scaleStart: 0.8, scaleMid: 0.98, scaleEnd: 1.04 },
  { id: 'b3', size: 44, left: '15%', bottom: '-12%', duration: '36s', delay: '2s', opacity: 0.15, blur: 0.2, driftA: '-12px', driftB: '18px', driftC: '-8px', scaleStart: 0.82, scaleMid: 1, scaleEnd: 1.06 },
  { id: 'b4', size: 64, left: '20%', bottom: '-24%', duration: '43s', delay: '7s', opacity: 0.18, blur: 0.5, driftA: '18px', driftB: '-22px', driftC: '10px', scaleStart: 0.84, scaleMid: 1.02, scaleEnd: 1.08 },
  { id: 'b5', size: 26, left: '24%', bottom: '-15%', duration: '31s', delay: '1.5s', opacity: 0.14, blur: 0.1, driftA: '-8px', driftB: '12px', driftC: '-14px', scaleStart: 0.78, scaleMid: 0.94, scaleEnd: 1.01 },
  { id: 'b6', size: 52, left: '29%', bottom: '-20%', duration: '41s', delay: '10s', opacity: 0.17, blur: 0.6, driftA: '20px', driftB: '-12px', driftC: '16px', scaleStart: 0.83, scaleMid: 1.01, scaleEnd: 1.07 },
  { id: 'b7', size: 34, left: '34%', bottom: '-8%', duration: '33s', delay: '5s', opacity: 0.16, blur: 0.2, driftA: '12px', driftB: '-16px', driftC: '6px', scaleStart: 0.8, scaleMid: 0.98, scaleEnd: 1.03 },
  { id: 'b8', size: 78, left: '39%', bottom: '-26%', duration: '46s', delay: '12s', opacity: 0.19, blur: 0.8, driftA: '-18px', driftB: '24px', driftC: '-12px', scaleStart: 0.86, scaleMid: 1.04, scaleEnd: 1.1 },
  { id: 'b9', size: 24, left: '44%', bottom: '-14%', duration: '30s', delay: '3s', opacity: 0.12, blur: 0.1, driftA: '8px', driftB: '-10px', driftC: '12px', scaleStart: 0.77, scaleMid: 0.93, scaleEnd: 1 },
  { id: 'b10', size: 58, left: '49%', bottom: '-22%', duration: '42s', delay: '8s', opacity: 0.18, blur: 0.5, driftA: '22px', driftB: '-18px', driftC: '10px', scaleStart: 0.84, scaleMid: 1.02, scaleEnd: 1.08 },
  { id: 'b11', size: 38, left: '53%', bottom: '-11%', duration: '35s', delay: '11s', opacity: 0.15, blur: 0.3, driftA: '-10px', driftB: '14px', driftC: '-6px', scaleStart: 0.81, scaleMid: 0.97, scaleEnd: 1.04 },
  { id: 'b12', size: 90, left: '58%', bottom: '-28%', duration: '49s', delay: '6s', opacity: 0.2, blur: 0.9, driftA: '24px', driftB: '-26px', driftC: '14px', scaleStart: 0.88, scaleMid: 1.06, scaleEnd: 1.12 },
  { id: 'b13', size: 28, left: '62%', bottom: '-16%', duration: '32s', delay: '14s', opacity: 0.13, blur: 0.2, driftA: '10px', driftB: '-8px', driftC: '5px', scaleStart: 0.79, scaleMid: 0.95, scaleEnd: 1.02 },
  { id: 'b14', size: 46, left: '67%', bottom: '-12%', duration: '38s', delay: '9s', opacity: 0.17, blur: 0.4, driftA: '-14px', driftB: '18px', driftC: '-10px', scaleStart: 0.82, scaleMid: 1, scaleEnd: 1.05 },
  { id: 'b15', size: 70, left: '72%', bottom: '-24%', duration: '44s', delay: '13s', opacity: 0.18, blur: 0.7, driftA: '18px', driftB: '-20px', driftC: '15px', scaleStart: 0.85, scaleMid: 1.03, scaleEnd: 1.09 },
  { id: 'b16', size: 24, left: '76%', bottom: '-10%', duration: '29s', delay: '2.5s', opacity: 0.12, blur: 0.1, driftA: '-6px', driftB: '12px', driftC: '-8px', scaleStart: 0.76, scaleMid: 0.92, scaleEnd: 0.99 },
  { id: 'b17', size: 56, left: '81%', bottom: '-18%', duration: '40s', delay: '15s', opacity: 0.17, blur: 0.5, driftA: '20px', driftB: '-14px', driftC: '9px', scaleStart: 0.83, scaleMid: 1.01, scaleEnd: 1.07 },
  { id: 'b18', size: 82, left: '86%', bottom: '-30%', duration: '47s', delay: '5.5s', opacity: 0.19, blur: 0.8, driftA: '-20px', driftB: '26px', driftC: '-12px', scaleStart: 0.87, scaleMid: 1.05, scaleEnd: 1.11 },
  { id: 'b19', size: 32, left: '90%', bottom: '-13%', duration: '34s', delay: '17s', opacity: 0.15, blur: 0.3, driftA: '12px', driftB: '-12px', driftC: '7px', scaleStart: 0.8, scaleMid: 0.96, scaleEnd: 1.03 },
  { id: 'b20', size: 48, left: '94%', bottom: '-19%', duration: '37s', delay: '1s', opacity: 0.16, blur: 0.4, driftA: '-16px', driftB: '14px', driftC: '-10px', scaleStart: 0.82, scaleMid: 0.99, scaleEnd: 1.05 },
  { id: 'b21', size: 60, left: '12%', bottom: '-32%', duration: '45s', delay: '18s', opacity: 0.17, blur: 0.7, driftA: '16px', driftB: '-18px', driftC: '11px', scaleStart: 0.85, scaleMid: 1.03, scaleEnd: 1.08 },
  { id: 'b22', size: 72, left: '64%', bottom: '-34%', duration: '48s', delay: '20s', opacity: 0.18, blur: 0.8, driftA: '-22px', driftB: '20px', driftC: '-14px', scaleStart: 0.86, scaleMid: 1.04, scaleEnd: 1.1 },
]

const backgroundStyle = {
  backgroundImage:
    "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(3,12,28,0.4) 48%, rgba(2,8,23,0.78) 100%), url('/assets/ocean-background.svg'), radial-gradient(circle at 20% 12%, rgba(189,242,255,0.34), transparent 26%), radial-gradient(circle at 80% 18%, rgba(120,197,255,0.2), transparent 28%), linear-gradient(180deg, #8bd6ff 0%, #2f86c6 34%, #0b3d74 72%, #04172f 100%)",
}

const visibleFiles = computed(() => {
  const query = search.value.trim().toLowerCase()

  if (!query) {
    return files.value
  }

  return files.value.filter((file) => file.name.toLowerCase().includes(query))
})

const totalFiles = computed(() => files.value.length)

const latestDateLabel = computed(() => {
  if (files.value.length === 0) {
    return 'No entries'
  }

  return files.value
    .map((file) => file.date || '')
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || 'No entries'
})

const typeLabel = computed(() => {
  const uniqueTypes = [...new Set(files.value.map((file) => file.type))]

  if (uniqueTypes.length === 0) {
    return 'Waiting'
  }

  return uniqueTypes.slice(0, 3).join(' / ')
})

const summaryCards = computed(() =>
  [
    {
      title: 'Resource Library',
      value: `${totalFiles.value} files`,
      detail: 'Static file listings sourced from a versioned JSON manifest.',
    },
    {
      title: 'Direct Downloads',
      value: 'No upload flow',
      detail: 'Every action is a direct static file link, ready for Vercel delivery.',
    },
    {
      title: 'Latest Update',
      value: latestDateLabel.value,
      detail: manifestUpdatedAt.value ? `Manifest refreshed on ${manifestUpdatedAt.value}.` : 'Manifest date is optional.',
    },
    {
      title: 'Primary Formats',
      value: typeLabel.value,
      detail: 'Use the search field to filter by file name only.',
    },
  ].map((card, index) => ({
    ...card,
    ...summaryThemes[index % summaryThemes.length],
  })),
)

const fileBadgeClass = (type) => {
  const styles = {
    archive: 'bg-white/10 text-blue-100',
    document: 'bg-cyan-200/[0.15] text-cyan-50',
    image: 'bg-emerald-200/[0.15] text-emerald-50',
    video: 'bg-indigo-200/20 text-indigo-50',
    other: 'bg-slate-200/[0.14] text-slate-50',
  }

  return styles[type] || styles.other
}

const normalizeFile = (item) => ({
  name: String(item?.name || 'Untitled file'),
  path: String(item?.path || '#'),
  size: String(item?.size || 'Unknown size'),
  date: String(item?.date || 'Unknown date'),
  type: String(item?.type || 'other').toLowerCase(),
  description: String(item?.description || ''),
})

const loadManifest = async () => {
  loadingManifest.value = true
  errorMessage.value = ''

  try {
    const response = await fetch('/files/files.json', {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
      },
    })

    const payload = await response.json()

    if (!response.ok) {
      throw new Error('Unable to load the static file manifest.')
    }

    const manifestFiles = Array.isArray(payload) ? payload : payload?.files

    if (!Array.isArray(manifestFiles)) {
      throw new Error('The file manifest format is invalid.')
    }

    manifestTitle.value = typeof payload?.title === 'string' && payload.title ? payload.title : 'Map7e Cloud Resource Library'
    manifestUpdatedAt.value = typeof payload?.updatedAt === 'string' ? payload.updatedAt : ''
    files.value = manifestFiles.map(normalizeFile)
  } catch (error) {
    files.value = []
    errorMessage.value = error instanceof Error ? error.message : 'Unable to load the static file manifest.'
  } finally {
    loadingManifest.value = false
  }
}

onMounted(async () => {
  requestAnimationFrame(() => {
    panelVisible.value = true
  })

  await loadManifest()
})
</script>

<template>
  <div class="relative min-h-screen overflow-hidden bg-slate-950 font-body text-white">
    <div class="absolute inset-0 ocean-scene">
      <div class="absolute inset-0 bg-cover bg-center" :style="backgroundStyle" />
      <div class="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),transparent_26%,rgba(3,12,28,0.62)_100%)]" />
      <div class="absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.22),transparent_62%)] opacity-70" />
      <div class="absolute inset-0 light-rays opacity-30" />
      <div class="absolute -left-16 top-16 h-72 w-72 rounded-full bg-cyan-200/[0.12] blur-3xl float-slow" />
      <div class="absolute right-[-7rem] top-1/3 h-[24rem] w-[24rem] rounded-full bg-sky-300/10 blur-3xl float-reverse" />
      <div class="absolute bottom-[-10rem] left-1/3 h-[22rem] w-[22rem] rounded-full bg-blue-500/20 blur-3xl float-slow" />
      <div
        v-for="bubble in bubbleSpecs"
        :key="bubble.id"
        class="absolute bubble"
        :style="{
          width: `${bubble.size}px`,
          height: `${bubble.size}px`,
          left: bubble.left,
          bottom: bubble.bottom,
          animationDelay: bubble.delay,
          animationDuration: bubble.duration,
          opacity: bubble.opacity,
          filter: `blur(${bubble.blur}px)`,
          '--drift-a': bubble.driftA,
          '--drift-b': bubble.driftB,
          '--drift-c': bubble.driftC,
          '--scale-start': bubble.scaleStart,
          '--scale-mid': bubble.scaleMid,
          '--scale-end': bubble.scaleEnd,
        }"
      />
    </div>

    <div class="absolute inset-0 bg-gradient-to-b from-slate-950/[0.08] via-slate-950/[0.22] to-slate-950/[0.58]" />

    <div class="relative flex min-h-screen items-center justify-center p-6 md:p-10">
      <div
        class="relative flex h-[80vh] w-[80vw] max-w-[1300px] flex-col overflow-hidden rounded-[20px] border border-white/[0.22] bg-white/[0.15] shadow-[0_26px_90px_rgba(4,23,47,0.38)] backdrop-blur-[20px] transition-all duration-700 ease-out"
        :class="panelVisible ? 'translate-y-0 opacity-100' : 'translate-y-5 opacity-0'"
      >
        <div class="pointer-events-none absolute inset-0 rounded-[20px] border border-cyan-100/[0.08]" />
        <div class="pointer-events-none absolute inset-0 rounded-[20px] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_0_48px_rgba(56,189,248,0.08)]" />

        <header class="relative z-10 flex flex-col gap-3 border-b border-white/10 px-6 py-3 md:px-8">
          <nav class="flex items-center overflow-x-auto text-[0.78rem] text-white/[0.48]">
            <span class="rounded-full bg-white/[0.06] px-3 py-1 text-white/[0.7]">Ocean Theme</span>
            <span class="px-2 text-white/[0.25]">/</span>
            <span class="rounded-full bg-white/[0.06] px-3 py-1 text-white/[0.7]">Static Downloads</span>
            <span class="px-2 text-white/[0.25]">/</span>
            <span class="rounded-full bg-white/[0.06] px-3 py-1 text-white/[0.7]">Vercel Ready</span>
          </nav>

          <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div class="min-w-0">
              <h1 class="truncate font-display text-[1.4rem] font-semibold text-white/95 md:text-[1.55rem]">{{ manifestTitle }}</h1>
              <p class="mt-1 text-sm text-white/[0.62]">
                A static download center for curated resources. Browse the manifest, search by file name, and download directly.
              </p>
            </div>

            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
              <label class="relative block min-w-[18rem] max-w-full lg:w-[22rem]">
                <span class="pointer-events-none absolute inset-y-0 left-4 flex items-center text-white/[0.45]">
                  <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M14.166 14.167 17.5 17.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    <circle cx="8.75" cy="8.75" r="5.917" stroke="currentColor" stroke-width="1.6" />
                  </svg>
                </span>
                <input
                  v-model="search"
                  type="text"
                  placeholder="Search resources by file name"
                  class="w-full rounded-full border border-white/10 bg-white/10 py-3 pl-11 pr-4 text-sm text-white placeholder:text-white/[0.45] outline-none transition duration-300 focus:border-cyan-200/[0.35] focus:bg-white/[0.14] focus:shadow-[0_0_0_4px_rgba(125,211,252,0.08)]"
                />
              </label>

              <a
                href="/files/files.json"
                class="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-sky-400 via-cyan-300 to-blue-400 px-5 py-3 text-sm font-semibold text-slate-950 shadow-[0_12px_30px_rgba(56,189,248,0.28)] transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_16px_38px_rgba(96,165,250,0.42)] focus:outline-none"
              >
                View Manifest
              </a>
            </div>
          </div>
        </header>

        <div class="relative z-10 flex min-h-0 flex-1 flex-col px-6 pb-5 pt-2.5 md:px-8 md:pb-6">
          <div v-if="errorMessage" class="mb-4 rounded-2xl border border-rose-200/20 bg-rose-300/[0.08] px-4 py-3 text-sm text-rose-50">
            {{ errorMessage }}
          </div>

          <section class="mb-2.5 shrink-0">
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <article
                v-for="card in summaryCards"
                :key="card.title"
                class="group rounded-[20px] border border-white/10 bg-white/[0.08] p-4 text-left shadow-[0_12px_35px_rgba(15,23,42,0.14)] transition duration-300 hover:-translate-y-1 hover:bg-white/[0.11] hover:shadow-[0_18px_40px_rgba(14,116,144,0.16)]"
              >
                <div class="flex items-start justify-between gap-3">
                  <div
                    class="flex h-11 w-11 items-center justify-center rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]"
                    :class="card.iconBg"
                  >
                    <svg class="h-5.5 w-5.5 text-sky-700" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M6.5 5.75h6.2a1.75 1.75 0 0 1 1.24.51l3.3 3.3a1.75 1.75 0 0 1 .51 1.24v7.7a1.75 1.75 0 0 1-1.75 1.75H6.5a1.75 1.75 0 0 1-1.75-1.75V7.5A1.75 1.75 0 0 1 6.5 5.75Z"
                        fill="currentColor"
                        opacity="0.18"
                      />
                      <path d="M8 12.25h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                      <path d="M8 15.75h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                    </svg>
                  </div>

                  <span class="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white/[0.65] transition group-hover:bg-white/[0.15] group-hover:text-white/80">
                    {{ card.title }}
                  </span>
                </div>

                <div class="mt-6">
                  <p class="text-[1.02rem] font-medium text-white/95">{{ card.value }}</p>
                  <p class="mt-1.5 text-sm leading-6 text-white/[0.56]">{{ card.detail }}</p>
                  <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-[#1F2E40]">
                    <div class="h-full w-4/5 rounded-full bg-gradient-to-r" :class="card.accent" />
                  </div>
                </div>
              </article>
            </div>
          </section>

          <section class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-white/10 bg-slate-950/[0.18] px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] md:px-5">
            <div class="mb-2.5 flex items-center justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.28em] text-cyan-100/60">Downloads</p>
                <h3 class="mt-1 font-display text-lg font-semibold text-white/95">Static file catalog</h3>
              </div>
              <div class="rounded-full bg-white/[0.06] px-3 py-1.5 text-sm text-white/60">
                {{ loadingManifest ? 'Loading...' : `${visibleFiles.length} items` }}
              </div>
            </div>

            <div class="file-list-scroll min-h-0 flex-1 overflow-auto pr-1">
              <div class="hidden grid-cols-[minmax(0,1.8fr)_110px_128px_120px] gap-4 px-3 pb-2 text-xs uppercase tracking-[0.24em] text-white/40 md:grid">
                <span>Name</span>
                <span>Size</span>
                <span>Date</span>
                <span class="text-right">Download</span>
              </div>

              <div v-if="loadingManifest" class="space-y-2">
                <div v-for="row in 4" :key="row" class="grid grid-cols-1 gap-4 rounded-2xl bg-white/[0.05] px-3 py-4 md:grid-cols-[minmax(0,1.8fr)_110px_128px_120px]">
                  <div class="h-14 animate-pulse rounded-2xl bg-white/[0.08]" />
                  <div class="h-10 animate-pulse rounded-2xl bg-white/[0.08]" />
                  <div class="h-10 animate-pulse rounded-2xl bg-white/[0.08]" />
                  <div class="h-10 animate-pulse rounded-2xl bg-white/[0.08]" />
                </div>
              </div>

              <div v-else class="space-y-2">
                <article
                  v-for="file in visibleFiles"
                  :key="file.path"
                  class="grid grid-cols-1 gap-4 rounded-2xl border border-transparent px-3 py-3 text-sm transition duration-300 hover:-translate-y-0.5 hover:border-white/[0.08] hover:bg-white/[0.07] hover:shadow-[0_16px_30px_rgba(15,23,42,0.18)] md:grid-cols-[minmax(0,1.8fr)_110px_128px_120px] md:items-center"
                >
                  <div class="flex min-w-0 items-start gap-3">
                    <div class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
                      <svg class="h-5 w-5 text-white/[0.85]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M14.25 3.75H7.5A1.75 1.75 0 0 0 5.75 5.5v13A1.75 1.75 0 0 0 7.5 20.25h9A1.75 1.75 0 0 0 18.25 18.5V7.75l-4-4Z"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linejoin="round"
                        />
                        <path d="M14.25 3.75V7.5h3.75" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                      </svg>
                    </div>

                    <div class="min-w-0">
                      <div class="flex flex-wrap items-center gap-2">
                        <p class="truncate text-[0.94rem] font-medium text-white/92">{{ file.name }}</p>
                        <span class="inline-flex rounded-full px-2.5 py-1 text-[0.7rem] font-medium uppercase tracking-[0.2em]" :class="fileBadgeClass(file.type)">
                          {{ file.type }}
                        </span>
                      </div>
                      <p v-if="file.description" class="mt-1.5 text-sm leading-6 text-white/[0.56]">
                        {{ file.description }}
                      </p>
                      <div class="mt-2 flex flex-wrap gap-2 text-xs text-white/[0.5] md:hidden">
                        <span class="rounded-full bg-white/[0.06] px-3 py-1">Size {{ file.size }}</span>
                        <span class="rounded-full bg-white/[0.06] px-3 py-1">Date {{ file.date }}</span>
                      </div>
                    </div>
                  </div>

                  <span class="hidden text-white/[0.65] md:block">{{ file.size }}</span>
                  <span class="hidden text-white/[0.55] md:block">{{ file.date }}</span>
                  <div class="flex md:justify-end">
                    <a
                      :href="file.path"
                      download
                      class="inline-flex w-full items-center justify-center rounded-full border border-cyan-200/20 bg-white/[0.08] px-4 py-2.5 text-sm font-semibold text-cyan-50 transition duration-300 hover:border-cyan-200/35 hover:bg-white/[0.14] hover:text-white md:w-auto"
                    >
                      Download
                    </a>
                  </div>
                </article>

                <div v-if="visibleFiles.length === 0" class="rounded-[20px] border border-white/10 bg-white/[0.05] px-6 py-10 text-center text-white/60">
                  No resources match the current search.
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ocean-scene {
  animation: drift-zoom 24s ease-in-out infinite alternate;
  transform-origin: center;
}

.light-rays {
  background:
    linear-gradient(112deg, rgba(255, 255, 255, 0.16), transparent 24%),
    linear-gradient(96deg, rgba(255, 255, 255, 0.08), transparent 20%),
    linear-gradient(80deg, rgba(255, 255, 255, 0.06), transparent 18%);
  filter: blur(12px);
  transform: translateY(-8%) scale(1.15);
}

.float-slow {
  animation: float-slow 16s ease-in-out infinite;
}

.float-reverse {
  animation: float-reverse 18s ease-in-out infinite;
}

.bubble {
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background:
    radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.12) 30%, rgba(255, 255, 255, 0.04) 55%, transparent 74%),
    radial-gradient(circle at 68% 72%, rgba(110, 190, 255, 0.1), transparent 62%);
  box-shadow:
    inset -8px -10px 18px rgba(255, 255, 255, 0.06),
    inset 8px 10px 18px rgba(255, 255, 255, 0.12),
    0 0 18px rgba(148, 220, 255, 0.07);
  animation-name: bubble-rise;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}

.file-list-scroll {
  scrollbar-width: thin;
  scrollbar-color: #1f2e40 rgba(15, 23, 42, 0.22);
}

.file-list-scroll::-webkit-scrollbar {
  width: 10px;
}

.file-list-scroll::-webkit-scrollbar-track {
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.22);
}

.file-list-scroll::-webkit-scrollbar-thumb {
  border: 2px solid rgba(15, 23, 42, 0.22);
  border-radius: 999px;
  background: #1f2e40;
}

.file-list-scroll::-webkit-scrollbar-thumb:hover {
  background: #25384f;
}

@keyframes bubble-rise {
  0% {
    transform: translate3d(0, 0, 0) scale(var(--scale-start, 0.82));
  }
  32% {
    transform: translate3d(var(--drift-a, 12px), -34vh, 0) scale(var(--scale-mid, 0.98));
  }
  68% {
    transform: translate3d(var(--drift-b, -14px), -78vh, 0) scale(1);
  }
  100% {
    transform: translate3d(var(--drift-c, 10px), -118vh, 0) scale(var(--scale-end, 1.08));
  }
}

@keyframes float-slow {
  0%,
  100% {
    transform: translate3d(0, 0, 0);
  }
  50% {
    transform: translate3d(0, -12px, 0);
  }
}

@keyframes float-reverse {
  0%,
  100% {
    transform: translate3d(0, 0, 0);
  }
  50% {
    transform: translate3d(0, 14px, 0);
  }
}

@keyframes drift-zoom {
  0% {
    transform: scale(1) translate3d(0, 0, 0);
  }
  100% {
    transform: scale(1.05) translate3d(0, -1.2%, 0);
  }
}
</style>
