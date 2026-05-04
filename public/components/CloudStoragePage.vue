<script setup>
import { computed, onMounted, ref } from 'vue'

const folderThemes = [
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

const TEXT = {
  home: '\u5bb6',
  root: '\u6839\u76ee\u5f55',
  rootOverview: '\u6839\u76ee\u5f55\u6982\u89c8',
  fileListSuffix: '\u6587\u4ef6\u5217\u8868',
  pageType: '\u9759\u6001\u4e91\u7aef\u8d44\u6e90\u7ad9',
  intro: '\u4fdd\u6301\u76ee\u5f55\u5207\u6362\u4e0e\u4e0b\u8f7d\u4f53\u9a8c\uff0c\u6240\u6709\u5185\u5bb9\u5747\u6765\u81ea\u9759\u6001 JSON \u4e0e /downloads \u8d44\u6e90\u76ee\u5f55\u3002',
  searchRoot: '\u8bf7\u5148\u8fdb\u5165\u4e00\u4e2a\u76ee\u5f55\u540e\u518d\u641c\u7d22',
  searchInPrefix: '\u5728',
  searchInSuffix: '\u4e2d\u641c\u7d22\u6587\u4ef6',
  brandingSubline: '\u6d77\u6d0b\u98ce\u683c\u9759\u6001\u4e91\u76d8',
  loading: '\u52a0\u8f7d\u4e2d',
  files: '\u6587\u4ef6',
  folders: '\u76ee\u5f55',
  totalFiles: '\u6587\u4ef6\u603b\u6570',
  lastUpdated: '\u6700\u65b0\u66f4\u65b0',
  loadingLibrary: '\u6b63\u5728\u8f7d\u5165\u76ee\u5f55\u6570\u636e',
  fileName: '\u6587\u4ef6\u540d',
  fileSize: '\u5927\u5c0f',
  fileDate: '\u65e5\u671f',
  action: '\u64cd\u4f5c',
  download: '\u4e0b\u8f7d',
  emptyFolder: '\u5f53\u524d\u76ee\u5f55\u6682\u65e0\u53ef\u4e0b\u8f7d\u6587\u4ef6\u3002',
  noMatch: '\u5f53\u524d\u76ee\u5f55\u4e0b\u6ca1\u6709\u5339\u914d\u5173\u952e\u8bcd\u7684\u6587\u4ef6\u3002',
  rootGuide: '\u70b9\u51fb\u4e0a\u65b9\u76ee\u5f55\u5361\u7247\uff0c\u5373\u53ef\u8fdb\u5165\u5bf9\u5e94\u5206\u7c7b\u67e5\u770b\u5e76\u4e0b\u8f7d\u6587\u4ef6\u3002',
  rootFoldersHint: '\u5df2\u63d0\u4f9b 3 \u4e2a\u6839\u76ee\u5f55\uff0c\u7528\u4e8e\u5feb\u901f\u8fdb\u5165\u4e0d\u540c\u8d44\u6e90\u5206\u7c7b\u3002',
  totalFilesHint: '\u6240\u6709\u8d44\u6e90\u90fd\u4ece /downloads/... \u76f4\u63a5\u4e0b\u8f7d\u3002',
  lastUpdatedHintPrefix: '\u76ee\u5f55\u6e05\u5355\u66f4\u65b0\u65f6\u95f4\uff1a',
  lastUpdatedHintFallback: '\u672a\u6807\u6ce8',
  updatedPrefix: '\u66f4\u65b0\u4e8e',
  itemUnit: '\u9879',
  copyright: 'Copyright \u00a9 2026 Map7e. All rights reserved.',
  errorFallback: '\u65e0\u6cd5\u8f7d\u5165\u9759\u6001\u76ee\u5f55\u6e05\u5355\u3002',
  invalidManifest: '\u76ee\u5f55\u6e05\u5355\u683c\u5f0f\u4e0d\u6b63\u786e\u3002',
}

const panelVisible = ref(false)
const search = ref('')
const manifestTitle = ref('Map7e Cloud Resource Library')
const manifestUpdatedAt = ref('')
const rootFolders = ref([])
const folderMap = ref({})
const activeFolderSlug = ref('')
const loadingLibrary = ref(false)
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

const beachBackgroundImage = 'https://source.unsplash.com/1920x1080/?beach,sea'

const backgroundStyle = {
  backgroundImage: `url("${beachBackgroundImage}")`,
  backgroundSize: 'cover',
  backgroundPosition: 'center',
  backgroundRepeat: 'no-repeat',
  backgroundAttachment: 'fixed',
}

const activeFolder = computed(() => folderMap.value[activeFolderSlug.value] || null)

const currentFiles = computed(() => activeFolder.value?.files || [])

const visibleFiles = computed(() => {
  const query = search.value.trim().toLowerCase()

  if (!query) {
    return currentFiles.value
  }

  return currentFiles.value.filter((file) => file.name.toLowerCase().includes(query))
})

const allFiles = computed(() =>
  Object.values(folderMap.value).flatMap((folder) => folder.files || []),
)

const totalFiles = computed(() => allFiles.value.length)

const currentViewDescription = computed(() =>
  activeFolder.value?.description || TEXT.rootGuide,
)

const latestDateLabel = computed(() => {
  if (allFiles.value.length === 0) {
    return '--'
  }

  return allFiles.value
    .map((file) => file.date || '')
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || '--'
})

const breadcrumbs = computed(() => {
  const items = [{ label: TEXT.home, slug: '' }]

  if (activeFolder.value) {
    items.push({
      label: activeFolder.value.name,
      slug: activeFolderSlug.value,
    })
  }

  return items
})

const themedRootFolders = computed(() =>
  rootFolders.value.map((folder, index) => {
    const folderFiles = folderMap.value[folder.slug]?.files || []

    return {
      ...folder,
      ...folderThemes[index % folderThemes.length],
      itemCountLabel: `${folderFiles.length} ${TEXT.itemUnit}`,
    }
  }),
)

const searchPlaceholder = computed(() => {
  if (!activeFolder.value) {
    return TEXT.searchRoot
  }

  return `${TEXT.searchInPrefix}${activeFolder.value.name}${TEXT.searchInSuffix}`
})

const currentListTitle = computed(() => {
  if (!activeFolder.value) {
    return TEXT.loadingLibrary
  }

  return `${activeFolder.value.name}${TEXT.fileListSuffix}`
})

const currentItemCountLabel = computed(() =>
  loadingLibrary.value ? TEXT.loading : `${visibleFiles.value.length} ${TEXT.itemUnit}`,
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

const fileTypeLabel = (type) => {
  const labels = {
    archive: '\u538b\u7f29\u5305',
    document: '\u6587\u6863',
    image: '\u56fe\u7247',
    video: '\u89c6\u9891',
    other: '\u5176\u4ed6',
  }

  return labels[type] || labels.other
}

const normalizeFolder = (folder, fallbackUpdatedAt) => ({
  slug: String(folder?.slug || ''),
  name: String(folder?.name || '\u672a\u547d\u540d\u76ee\u5f55'),
  description: String(folder?.description || ''),
  updatedLabel: String(folder?.updatedLabel || fallbackUpdatedAt || '--'),
})

const normalizeFile = (item) => ({
  name: String(item?.name || '\u672a\u547d\u540d\u6587\u4ef6'),
  path: String(item?.path || '#'),
  size: String(item?.size || '--'),
  date: String(item?.date || '--'),
  type: String(item?.type || 'other').toLowerCase(),
  description: String(item?.description || ''),
})

const normalizeFolderMap = (folders) =>
  Object.fromEntries(
    Object.entries(folders || {}).map(([slug, folder]) => [
      slug,
      {
        name: String(folder?.name || slug),
        description: String(folder?.description || ''),
        files: Array.isArray(folder?.files) ? folder.files.map(normalizeFile) : [],
      },
    ]),
  )

const openFolder = (slug) => {
  if (!folderMap.value[slug]) {
    return
  }

  activeFolderSlug.value = slug
  search.value = ''
}

const goHome = () => {
  activeFolderSlug.value = ''
  search.value = ''
}

const openBreadcrumb = (slug) => {
  if (!slug) {
    goHome()
    return
  }

  openFolder(slug)
}

const loadLibrary = async () => {
  loadingLibrary.value = true
  errorMessage.value = ''

  try {
    const response = await fetch('/files/library.json', {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
      },
    })

    const payload = await response.json()

    if (!response.ok) {
      throw new Error(TEXT.errorFallback)
    }

    if (!Array.isArray(payload?.rootFolders) || typeof payload?.folders !== 'object' || payload?.folders === null) {
      throw new Error(TEXT.invalidManifest)
    }

    manifestTitle.value = typeof payload?.title === 'string' && payload.title ? payload.title : 'Map7e Cloud Resource Library'
    manifestUpdatedAt.value = typeof payload?.updatedAt === 'string' ? payload.updatedAt : ''
    rootFolders.value = payload.rootFolders.map((folder) => normalizeFolder(folder, payload?.updatedAt))
    folderMap.value = normalizeFolderMap(payload.folders)
  } catch (error) {
    rootFolders.value = []
    folderMap.value = {}
    errorMessage.value = error instanceof Error ? error.message : TEXT.errorFallback
  } finally {
    loadingLibrary.value = false
  }
}

onMounted(async () => {
  document.body.style.backgroundImage = `url(${beachBackgroundImage})`
  document.body.style.backgroundSize = 'cover'
  document.body.style.backgroundPosition = 'center'
  document.body.style.backgroundRepeat = 'no-repeat'
  document.body.style.backgroundAttachment = 'fixed'

  requestAnimationFrame(() => {
    panelVisible.value = true
  })

  await loadLibrary()
})
</script>

<template>
  <div class="relative min-h-screen overflow-hidden bg-transparent font-body text-white">
    <div class="absolute inset-0 ocean-scene">
      <div class="absolute inset-0" :style="backgroundStyle" />
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

        <header class="relative z-10 flex flex-col gap-3 border-b border-white/10 px-6 py-4 md:px-8">
          <nav class="flex items-center overflow-x-auto text-[0.78rem] text-white/[0.48]">
            <template v-for="(crumb, index) in breadcrumbs" :key="`${crumb.slug || 'home'}-${index}`">
              <span v-if="index > 0" class="px-2 text-white/[0.25]">/</span>
              <button
                type="button"
                class="rounded-full bg-white/[0.06] px-3 py-1 transition hover:bg-white/[0.1] hover:text-white/[0.85]"
                :class="index === breadcrumbs.length - 1 ? 'text-white/[0.85]' : 'text-white/[0.62]'"
                @click="openBreadcrumb(crumb.slug)"
              >
                {{ crumb.label }}
              </button>
            </template>
          </nav>

          <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div class="min-w-0">
              <p class="text-sm leading-7 text-white/[0.62]">
                {{ currentViewDescription }}
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
                  :disabled="!activeFolder"
                  :placeholder="searchPlaceholder"
                  class="w-full rounded-full border border-white/10 bg-white/10 py-3 pl-11 pr-4 text-sm text-white placeholder:text-white/[0.45] outline-none transition duration-300 focus:border-cyan-200/[0.35] focus:bg-white/[0.14] focus:shadow-[0_0_0_4px_rgba(125,211,252,0.08)] disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>

              <div class="group flex min-w-[11.5rem] items-center gap-3 rounded-[18px] border border-white/12 bg-white/[0.09] px-4 py-3 shadow-[0_14px_30px_rgba(7,33,58,0.18)] backdrop-blur-xl">
                <div class="relative flex h-11 w-11 overflow-hidden rounded-2xl">
                   <img src="/assets/logo.png" class="w-full h-full object-cover" />
                      </div>
                <div class="min-w-0">
                  <p class="font-display text-[1.02rem] font-semibold tracking-[0.18em] text-white/95">Map7e</p>
                </div>
              </div>
            </div>
          </div>
        </header>

        <div class="relative z-10 flex min-h-0 flex-1 flex-col px-6 pb-5 pt-2.5 md:px-8 md:pb-6">
          <div v-if="errorMessage" class="mb-4 rounded-2xl border border-rose-200/20 bg-rose-300/[0.08] px-4 py-3 text-sm text-rose-50">
            {{ errorMessage }}
          </div>

          <section class="mb-2.5 shrink-0">
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <button
                v-for="folder in themedRootFolders"
                :key="folder.slug"
                type="button"
                class="group rounded-[20px] border border-white/10 bg-white/[0.08] p-4 text-left shadow-[0_12px_35px_rgba(15,23,42,0.14)] transition duration-300 hover:-translate-y-1 hover:bg-white/[0.11] hover:shadow-[0_18px_40px_rgba(14,116,144,0.16)]"
                :class="activeFolderSlug === folder.slug ? 'border-cyan-100/[0.24] bg-white/[0.14] shadow-[0_18px_42px_rgba(56,189,248,0.18)]' : ''"
                @click="openFolder(folder.slug)"
              >
                <div class="flex items-start justify-between gap-3">
                  <div
                    class="flex h-11 w-11 items-center justify-center rounded-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]"
                    :class="folder.iconBg"
                  >
                    <svg class="h-5.5 w-5.5 text-sky-700" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M3.75 8.25A2.25 2.25 0 0 1 6 6h3.214a2.25 2.25 0 0 1 1.591.659l1.036 1.035c.422.422.994.66 1.591.66H18A2.25 2.25 0 0 1 20.25 10.6v5.65A2.25 2.25 0 0 1 18 18.5H6a2.25 2.25 0 0 1-2.25-2.25v-8Z"
                        fill="currentColor"
                        opacity="0.18"
                      />
                      <path
                        d="M3.75 9.25h16.5v7A2.25 2.25 0 0 1 18 18.5H6a2.25 2.25 0 0 1-2.25-2.25v-7Z"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M3.75 9.25V8.25A2.25 2.25 0 0 1 6 6h3.214a2.25 2.25 0 0 1 1.591.659l1.036 1.035c.422.422.994.66 1.591.66H18A2.25 2.25 0 0 1 20.25 10.5v-1.25"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </div>

                  <span class="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white/[0.65] transition group-hover:bg-white/[0.15] group-hover:text-white/80">
                    {{ folder.itemCountLabel }}
                  </span>
                </div>

                <div class="mt-6">
                  <p class="text-[1.02rem] font-medium text-white/95">{{ folder.name }}</p>
                  <p class="mt-1.5 text-sm leading-6 text-white/[0.56]">{{ folder.description }}</p>
                  <p class="mt-2 text-xs uppercase tracking-[0.2em] text-white/[0.4]">{{ TEXT.updatedPrefix }} {{ folder.updatedLabel }}</p>
                  <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-[#1F2E40]">
                    <div class="h-full w-4/5 rounded-full bg-gradient-to-r" :class="folder.accent" />
                  </div>
                </div>
              </button>
            </div>
          </section>

          <section
            v-if="!activeFolder && !loadingLibrary"
            class="flex min-h-0 flex-1 flex-col justify-between overflow-hidden rounded-[22px] border border-white/10 bg-slate-950/[0.18] px-5 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
          >
            <div>
              <p class="text-xs uppercase tracking-[0.28em] text-cyan-100/60">{{ TEXT.pageType }}</p>
              <h3 class="mt-1 font-display text-lg font-semibold text-white/95">{{ TEXT.rootOverview }}</h3>
              <p class="mt-2 max-w-3xl text-sm leading-7 text-white/[0.58]">
                {{ TEXT.rootGuide }}
              </p>
            </div>

            <div class="grid gap-3 pt-6 md:grid-cols-3">
              <div class="rounded-[20px] border border-white/10 bg-white/[0.06] px-4 py-4">
                <p class="text-xs uppercase tracking-[0.22em] text-white/[0.42]">{{ TEXT.folders }}</p>
                <p class="mt-2 text-2xl font-semibold text-white/90">{{ themedRootFolders.length }}</p>
                <p class="mt-2 text-sm leading-6 text-white/[0.54]">{{ TEXT.rootFoldersHint }}</p>
              </div>
              <div class="rounded-[20px] border border-white/10 bg-white/[0.06] px-4 py-4">
                <p class="text-xs uppercase tracking-[0.22em] text-white/[0.42]">{{ TEXT.totalFiles }}</p>
                <p class="mt-2 text-2xl font-semibold text-white/90">{{ totalFiles }}</p>
                <p class="mt-2 text-sm leading-6 text-white/[0.54]">{{ TEXT.totalFilesHint }}</p>
              </div>
              <div class="rounded-[20px] border border-white/10 bg-white/[0.06] px-4 py-4">
                <p class="text-xs uppercase tracking-[0.22em] text-white/[0.42]">{{ TEXT.lastUpdated }}</p>
                <p class="mt-2 text-2xl font-semibold text-white/90">{{ latestDateLabel }}</p>
                <p class="mt-2 text-sm leading-6 text-white/[0.54]">{{ TEXT.lastUpdatedHintPrefix }}{{ manifestUpdatedAt || TEXT.lastUpdatedHintFallback }}</p>
              </div>
            </div>
          </section>

          <section
            v-else
            class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-white/10 bg-slate-950/[0.18] px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] md:px-5"
          >
            <div class="mb-2.5 flex items-center justify-between gap-3">
              <div>
                <p class="text-xs uppercase tracking-[0.28em] text-cyan-100/60">{{ activeFolder ? TEXT.files : TEXT.loading }}</p>
                <h3 class="mt-1 font-display text-lg font-semibold text-white/95">
                  {{ currentListTitle }}
                </h3>
              </div>
              <div class="rounded-full bg-white/[0.06] px-3 py-1.5 text-sm text-white/60">
                {{ currentItemCountLabel }}
              </div>
            </div>

            <div class="file-list-scroll min-h-0 flex-1 overflow-auto pr-1">
              <div class="hidden grid-cols-[minmax(0,1.8fr)_110px_128px_120px] gap-4 px-3 pb-2 text-xs uppercase tracking-[0.24em] text-white/40 md:grid">
                <span>{{ TEXT.fileName }}</span>
                <span>{{ TEXT.fileSize }}</span>
                <span>{{ TEXT.fileDate }}</span>
                <span class="text-right">{{ TEXT.action }}</span>
              </div>

              <div v-if="loadingLibrary" class="space-y-2">
                <div v-for="row in 4" :key="row" class="grid grid-cols-1 gap-4 rounded-2xl bg-white/[0.05] px-3 py-4 md:grid-cols-[minmax(0,1.8fr)_110px_128px_120px]">
                  <div class="h-14 animate-pulse rounded-2xl bg-white/[0.08]" />
                  <div class="h-10 animate-pulse rounded-2xl bg-white/[0.08]" />
                  <div class="h-10 animate-pulse rounded-2xl bg-white/[0.08]" />
                  <div class="h-10 animate-pulse rounded-2xl bg-white/[0.08]" />
                </div>
              </div>

              <div v-else-if="activeFolder" class="space-y-2">
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
                          {{ fileTypeLabel(file.type) }}
                        </span>
                      </div>
                      <p v-if="file.description" class="mt-1.5 text-sm leading-6 text-white/[0.56]">
                        {{ file.description }}
                      </p>
                      <div class="mt-2 flex flex-wrap gap-2 text-xs text-white/[0.5] md:hidden">
                        <span class="rounded-full bg-white/[0.06] px-3 py-1">{{ TEXT.fileSize }} {{ file.size }}</span>
                        <span class="rounded-full bg-white/[0.06] px-3 py-1">{{ TEXT.fileDate }} {{ file.date }}</span>
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
                      {{ TEXT.download }}
                    </a>
                  </div>
                </article>

                <div
                  v-if="activeFolder.files.length === 0"
                  class="rounded-[20px] border border-white/10 bg-white/[0.05] px-6 py-10 text-center text-white/60"
                >
                  {{ TEXT.emptyFolder }}
                </div>

                <div
                  v-else-if="visibleFiles.length === 0"
                  class="rounded-[20px] border border-white/10 bg-white/[0.05] px-6 py-10 text-center text-white/60"
                >
                  {{ TEXT.noMatch }}
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer class="relative z-10 border-t border-white/10 px-6 py-3 text-center text-xs tracking-[0.16em] text-white/[0.48] md:px-8">
          <div class="rounded-full border border-white/8 bg-white/[0.04] px-4 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            {{ TEXT.copyright }}
          </div>
        </footer>
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
