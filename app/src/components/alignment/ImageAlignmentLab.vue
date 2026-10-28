<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ImageAlignmentPanel from './ImageAlignmentPanel.vue'
import ImagePromptDetails from './ImagePromptDetails.vue'
import { t, setLocalePreference } from '../../i18n.ts'
import { releaseLibraryImage, type LibraryImage } from '../../image-library.ts'
defineProps<{ embedded?: boolean }>()
const images = ref<LibraryImage[]>([])
const selectedId = ref('')
const mode = ref<'overview' | 'detail'>('overview')
const selected = computed(() => images.value.find(image => image.id === selectedId.value))
const importError = ref('')
function add(file: File, demo = false, prompt = '', keywords: string[] = []) {
  const image: LibraryImage = { id: crypto.randomUUID(), file, url: URL.createObjectURL(file), prompt, keywords, demo, visited: false }
  images.value.push(image)
  if (!selectedId.value) selectedId.value = image.id
}
function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement
  importError.value = ''
  for (const file of Array.from(input.files ?? [])) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { importError.value = t('Use PNG, JPEG or WebP images.'); continue }
    add(file)
  }
  input.value = ''
}
function open(image: LibraryImage) { selectedId.value = image.id; image.visited = true; mode.value = 'detail' }
function chooseResult(event: Event, image: LibraryImage) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (file) {
    if (image.candidateUrl) URL.revokeObjectURL(image.candidateUrl)
    image.candidateUrl = URL.createObjectURL(file)
  }
  input.value = ''
}
onMounted(() => {
  const demos = [
    [960, 600, '#c6d6c6', 'Quiet room', ['interior', 'soft daylight', 'sage green']],
    [600, 900, '#e1c4b1', 'Desert tower', ['architecture', 'terracotta', 'vertical composition']],
    [900, 600, '#bbcdda', 'Blue mountains', ['landscape', 'layered mountains', 'cool palette']],
    [650, 650, '#d6c8df', 'Violet still life', ['still life', 'violet', 'geometric']],
    [600, 800, '#c4d5ba', 'Garden study', ['botanical', 'olive', 'portrait']],
    [1100, 550, '#e5cfad', 'Golden horizon', ['panorama', 'warm light', 'minimal']],
  ] as const
  demos.forEach(([width, height, color, name, words], index) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = color; ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff88'; ctx.beginPath(); ctx.arc(width * .7, height * .25, width * .16, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = ['#688a79', '#9d6c54', '#59798b', '#8e719b', '#738d5e', '#b4935c'][index]!
    ctx.beginPath(); ctx.moveTo(0, height); ctx.lineTo(width * .3, height * .4); ctx.lineTo(width * .65, height * .75); ctx.lineTo(width, height * .5); ctx.lineTo(width, height); ctx.fill()
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), c => c.charCodeAt(0))
    add(new File([bytes], `${name.toLowerCase().replaceAll(' ', '-')}.png`, { type: 'image/png' }), true, `Example only: ${name.toLowerCase()}, ${words.join(', ')}. A simple geometric illustration for local layout testing.`, [...words])
  })
})
onBeforeUnmount(() => images.value.forEach(image => releaseLibraryImage(image)))
</script>

<template>
  <main class="alignment-lab" :class="{ embedded }">
    <header v-if="!embedded"><div><h1>{{ t('Image alignment lab') }}</h1><p>{{ t('Local UI experiment. Nothing is uploaded or sent to an agent here; use the chat attachment preview for real requests.') }}</p></div><div class="lab-languages"><button class="btn" @click="setLocalePreference('zh-CN')">中文</button><button class="btn" @click="setLocalePreference('en')">English</button></div></header>
    <nav class="library-toolbar"><button class="btn overview-button" :aria-pressed="mode === 'overview'" @click="mode = 'overview'">{{ t('Image overview') }}</button><button class="btn detail-button" :disabled="!selected" :aria-pressed="mode === 'detail'" @click="selected && open(selected)">{{ t('View selected image') }}</button><label class="lab-file">{{ t('Import local images') }}<input type="file" multiple accept="image/png,image/jpeg,image/webp" @change="chooseFile"></label></nav>
    <p role="alert" v-if="importError">{{ importError }}</p>
    <div class="library-layout" :class="{ 'detail-layout': mode === 'detail' }">
      <div class="library-content">
        <section v-show="mode === 'overview'" class="image-masonry" :aria-label="t('Image overview')">
          <article v-for="image in images" :key="image.id" class="library-card" :class="{ selected: image.id === selectedId }">
            <button class="select-image" :aria-pressed="image.id === selectedId" @click="selectedId = image.id"><img :src="image.url" :alt="image.file.name"><span>{{ image.file.name }}</span><small>{{ image.keywords.join(' · ') || t('No keywords yet.') }}</small></button>
            <button class="btn open-image" @click="open(image)">{{ t('Open image details') }}</button>
          </article>
        </section>
        <template v-for="image in images" :key="image.id">
          <section v-if="image.visited" v-show="mode === 'detail' && selectedId === image.id" class="image-detail">
            <h2>{{ image.file.name }}</h2>
            <ImageAlignmentPanel compact :file="image.file" :editable="true" :active="mode === 'detail' && selectedId === image.id" @apply="image.applied = $event" @clear="image.applied = undefined"><template #details><ImagePromptDetails v-if="mode === 'detail' && selectedId === image.id" :image="image" /></template></ImageAlignmentPanel>
            <p>{{ t('Region drafts are kept per image while this page remains open.') }}</p>
            <section class="lab-output"><h2>{{ t('Instructions in this local draft') }}</h2><pre v-if="image.applied">{{ JSON.stringify(image.applied, null, 2) }}</pre><p v-else>{{ t('No region instructions have been applied.') }}</p></section>
            <section class="lab-output"><h2>{{ t('Compare a candidate result') }}</h2><p>{{ t('Load a result manually to compare. This does not claim that any AI tool has run.') }}</p><label class="lab-file">{{ t('Choose candidate image') }}<input type="file" accept="image/png,image/jpeg,image/webp" @change="chooseResult($event, image)"></label><div v-if="image.candidateUrl" class="lab-compare"><figure><figcaption>{{ t('Original image') }}</figcaption><img :src="image.url" :alt="t('Original image')"></figure><figure><figcaption>{{ t('Candidate image') }}</figcaption><img :src="image.candidateUrl" :alt="t('Candidate image')"></figure></div></section>
          </section>
        </template>
      </div>
      <ImagePromptDetails v-if="selected && mode === 'overview'" :image="selected" />
    </div>
  </main>
</template>

<style scoped>
.alignment-lab { width:min(1600px,100%);box-sizing:border-box;margin:0 auto;padding:28px;color:var(--c-text);overflow:auto;height:100dvh; } .alignment-lab.embedded { height:auto;width:100%;padding:0; }
header { display:flex;justify-content:space-between;gap:24px;align-items:start; } h1 { font-size:26px;margin:0 0 10px; } h2 { font-size:17px;overflow-wrap:anywhere; } p { color:var(--c-text-secondary);line-height:1.6;font-size:13px; } .lab-languages,.library-toolbar { display:flex;gap:8px;flex-wrap:wrap;align-items:center; } .library-toolbar { margin:20px 0; } .lab-file { display:flex;flex-wrap:wrap;gap:10px;font-size:13px; } .lab-file input { max-width:240px; }
.library-layout { display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px;align-items:start; } .library-layout.detail-layout { grid-template-columns:minmax(0,1fr); } .library-content { min-width:0; } .image-masonry { columns:3 180px;column-gap:16px; } .library-card { break-inside:avoid;margin:0 0 16px;border:2px solid transparent;border-radius:12px;overflow:hidden;background:var(--c-bg-muted);padding-bottom:10px; } .library-card.selected { border-color:#9673ce;box-shadow:0 0 0 2px #9673ce33; } .select-image { border:0;background:none;color:inherit;padding:0;width:100%;text-align:left;cursor:pointer; } .select-image img { display:block;width:100%;height:auto; } .select-image span,.select-image small { display:block;margin:10px;overflow-wrap:anywhere; } .select-image small { font-size:11px;color:var(--c-text-secondary);line-height:1.5; } .open-image { margin:0 10px; } .detail-large-image { display:block;width:100%;max-height:70vh;object-fit:contain;background:var(--c-bg-muted);border-radius:12px; } .region-tools { margin-top:20px; } summary { cursor:pointer;padding:12px 0; } .lab-output { border-top:1px solid var(--c-border);padding-top:16px;margin-top:20px; } pre { max-height:260px;overflow:auto;padding:16px;background:var(--c-bg-muted);font-size:12px; } .lab-compare { display:grid;grid-template-columns:1fr 1fr;gap:16px; } figure { margin:0;min-width:0; } figure img { max-width:100%;max-height:400px;object-fit:contain; } figcaption { margin-bottom:8px; }
@media(max-width:850px) { .library-layout { grid-template-columns:1fr; } .alignment-lab { padding:12px; } header { flex-wrap:wrap; } } @media(max-width:500px) { .image-masonry { columns:2;column-gap:10px; } .lab-compare { grid-template-columns:1fr; } }
</style>
