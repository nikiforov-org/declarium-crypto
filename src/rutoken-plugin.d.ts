/**
 * У `@aktivco/rutoken-plugin` нет ни типов, ни поля `exports` — только
 * `browser`, указывающее на минифицированный файл. Раньше из-за этого его
 * подключали тегом `<script>` из `public/`, а модуль читал `window.rutoken`;
 * библиотеке так жить нельзя — она не может класть файлы в чужой `public/`.
 *
 * В конце файла вендора стоит `module.exports = rutoken`, то есть пакет
 * прекрасно импортируется. Здесь только объявление, чтобы TypeScript его
 * пропустил; настоящая форма объекта описана в `rutoken.ts`.
 */
declare module '@aktivco/rutoken-plugin' {
  const rutoken: unknown
  export default rutoken
}
