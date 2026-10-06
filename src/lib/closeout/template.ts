import type { Division } from "../rules.ts";
import type { NewPunchItem } from "./types.ts";

// STARTER LIST. AL edits these; each job's list can also be changed item by item before it is invoiced.
// The Russian labels need a Russian speaker's review before crews rely on them.
type Pair = { en: string; ru: string };

const GENERAL: Pair[] = [
  { en: "Final walkthrough done with the customer", ru: "Финальный осмотр с заказчиком выполнен" },
  { en: "Job site cleaned and debris hauled away", ru: "Участок убран, мусор вывезен" },
  { en: "Magnet sweep of the yard and driveway done", ru: "Двор и подъездная дорожка проверены магнитом" },
  { en: "Customer has no open complaints", ru: "У заказчика нет нерешённых замечаний" },
  { en: "After photos taken and uploaded to CompanyCam", ru: "Фото «после» сделаны и загружены в CompanyCam" },
];

const BY_TRADE: Record<Division, Pair[]> = {
  roofing: [
    { en: "Flashing, vents and roof penetrations sealed", ru: "Примыкания, вентиляция и проходки кровли загерметизированы" },
    { en: "Shingles and ridge caps checked for missed nails and damage", ru: "Черепица и коньки проверены: нет пропущенных гвоздей и повреждений" },
  ],
  siding: [
    { en: "Trim, corners and caulking checked", ru: "Наличники, углы и герметизация проверены" },
    { en: "Siding free of scratches, dirt and gaps", ru: "Сайдинг без царапин, загрязнений и зазоров" },
  ],
  gutters: [
    { en: "Gutters tested with water, no leaks", ru: "Водостоки проверены водой, протечек нет" },
    { en: "Downspouts secured and directed away from the house", ru: "Водосточные трубы закреплены, вода отводится от дома" },
  ],
  windows_doors: [
    { en: "Windows and doors open, close and lock", ru: "Окна и двери открываются, закрываются и запираются" },
    { en: "Trim and sealant finished, stickers and film removed", ru: "Отделка и герметик завершены, наклейки и плёнка сняты" },
  ],
  insulation: [
    { en: "Insulation depth and coverage verified", ru: "Толщина и покрытие утеплителя проверены" },
    { en: "Attic hatch and access areas restored", ru: "Люк на чердак и места доступа восстановлены" },
  ],
  spray_foam: [
    { en: "Foam coverage and thickness verified", ru: "Покрытие и толщина пены проверены" },
    { en: "Overspray cleaned up", ru: "Излишки пены убраны" },
  ],
  commercial: [
    { en: "Customer's site contact signed off on the work", ru: "Представитель заказчика принял работы" },
    { en: "Safety barriers and equipment removed", ru: "Ограждения и оборудование убраны" },
  ],
};

/** The starting punchlist for a job: the whole-job items, then a few for each trade on it, in the job's trade order. */
export function starterItems(divisions: readonly Division[]): NewPunchItem[] {
  const out: NewPunchItem[] = GENERAL.map((p) => ({ division: null, labelEn: p.en, labelRu: p.ru }));
  for (const d of divisions) for (const p of BY_TRADE[d] ?? []) out.push({ division: d, labelEn: p.en, labelRu: p.ru });
  return out;
}
