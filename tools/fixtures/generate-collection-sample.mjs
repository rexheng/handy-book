import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FLAGSHIP = [
  {
    id: "honda-cb650r-2021",
    make: "Honda",
    model: "CB650R",
    year: 2021,
    years: [2019, 2020, 2021, 2022, 2023],
    cc: 649,
    category: "Naked",
    aliases: ["cb650r", "cb 650 r", "cb650", "honda cb650r"],
    thumb: "store/img/bikes/honda-cb650r-2021-thumb.webp",
    image: "store/img/bikes/honda-cb650r-2021.webp",
    bikez: "https://bikez.com/motorcycles/honda_cb650r_2021.php",
    manualId: "honda-cb650r-2021-om",
  },
  {
    id: "yamaha-mt-07-2021",
    make: "Yamaha",
    model: "MT-07",
    year: 2021,
    years: [2018, 2019, 2020, 2021, 2022],
    cc: 689,
    category: "Naked",
    aliases: ["mt-07", "mt07", "mt 07", "yamaha mt-07"],
    thumb: "store/img/bikes/yamaha-mt-07-2021-thumb.webp",
    image: "store/img/bikes/yamaha-mt-07-2021.webp",
    bikez: "https://bikez.com/motorcycles/yamaha_mt-07_2021.php",
    manualId: "yamaha-mt-07-2021-om",
  },
  {
    id: "kawasaki-z650-2020",
    make: "Kawasaki",
    model: "Z650",
    year: 2020,
    years: [2017, 2018, 2019, 2020, 2021],
    cc: 649,
    category: "Naked",
    aliases: ["z650", "z 650", "kawasaki z650"],
    thumb: "store/img/bikes/kawasaki-z650-2020-thumb.webp",
    image: "store/img/bikes/kawasaki-z650-2020.webp",
    bikez: "https://bikez.com/motorcycles/kawasaki_z650_2020.php",
    manualId: "kawasaki-z650-2020-om",
  },
  {
    id: "suzuki-sv650-2019",
    make: "Suzuki",
    model: "SV650",
    year: 2019,
    years: [2017, 2018, 2019, 2020, 2021],
    cc: 645,
    category: "Naked",
    aliases: ["sv650", "sv 650", "suzuki sv650"],
    thumb: "store/img/bikes/suzuki-sv650-2019-thumb.webp",
    image: "store/img/bikes/suzuki-sv650-2019.webp",
    bikez: "https://bikez.com/motorcycles/suzuki_sv650_2019.php",
    manualId: "suzuki-sv650-2019-om",
  },
  {
    id: "yamaha-yzf-r7-2022",
    make: "Yamaha",
    model: "YZF-R7",
    year: 2022,
    years: [2022, 2023, 2024],
    cc: 689,
    category: "Sport",
    aliases: ["yzf r7", "r7", "yzf-r7", "yamaha r7"],
    thumb: "store/img/collection/yamaha-yzf-r7-2022-thumb.webp",
    image: "store/img/collection/yamaha-yzf-r7-2022.webp",
    bikez: "https://bikez.com/motorcycles/yamaha_yzf-r7_2022.php",
    manualId: "yamaha-yzf-r7-2022-om",
  },
];

const MODELS = [
  ["Honda", "CB650R", 649, "Naked"],
  ["Honda", "CB650F", 649, "Naked"],
  ["Honda", "CB500F", 471, "Naked"],
  ["Honda", "CB500X", 471, "Adventure"],
  ["Honda", "CB300R", 286, "Naked"],
  ["Honda", "CB125R", 125, "Naked"],
  ["Honda", "CB1000R", 998, "Naked"],
  ["Honda", "CBR600RR", 599, "Sport"],
  ["Honda", "CBR650R", 649, "Sport"],
  ["Honda", "CBR1000RR", 1000, "Sport"],
  ["Honda", "CBR500R", 471, "Sport"],
  ["Honda", "Africa Twin", 1084, "Adventure"],
  ["Honda", "Rebel 500", 471, "Cruiser"],
  ["Honda", "Rebel 1100", 1084, "Cruiser"],
  ["Honda", "Grom", 124, "Mini"],
  ["Honda", "Gold Wing", 1833, "Touring"],
  ["Honda", "NC750X", 745, "Adventure"],
  ["Honda", "Forza 750", 745, "Scooter"],
  ["Honda", "CRF300L", 286, "Offroad"],
  ["Honda", "Shadow", 745, "Cruiser"],
  ["Honda", "VFR800", 782, "Sport"],
  ["Honda", "Monkey", 124, "Mini"],
  ["Honda", "CL500", 471, "Naked"],
  ["Honda", "Transalp", 755, "Adventure"],
  ["Honda", "Hornet 750", 755, "Naked"],
  ["Honda", "NT1100", 1084, "Touring"],
  ["Honda", "Super Cub", 125, "Underbone"],
  ["Honda", "Trail 125", 125, "Mini"],
  ["Yamaha", "YZF-R7", 689, "Sport"],
  ["Yamaha", "YZF-R1", 998, "Sport"],
  ["Yamaha", "YZF-R6", 599, "Sport"],
  ["Yamaha", "YZF-R3", 321, "Sport"],
  ["Yamaha", "MT-07", 689, "Naked"],
  ["Yamaha", "MT-09", 890, "Naked"],
  ["Yamaha", "MT-03", 321, "Naked"],
  ["Yamaha", "MT-10", 998, "Naked"],
  ["Yamaha", "Ténéré 700", 689, "Adventure"],
  ["Yamaha", "XSR700", 689, "Naked"],
  ["Yamaha", "XSR900", 890, "Naked"],
  ["Yamaha", "NMAX", 155, "Scooter"],
  ["Yamaha", "TMAX", 562, "Scooter"],
  ["Yamaha", "Tracer 9", 890, "Sport touring"],
  ["Yamaha", "Bolt", 942, "Cruiser"],
  ["Yamaha", "WR250R", 250, "Offroad"],
  ["Yamaha", "FJR1300", 1298, "Touring"],
  ["Yamaha", "XMax", 292, "Scooter"],
  ["Yamaha", "YZF-R15", 155, "Sport"],
  ["Yamaha", "FZ6", 600, "Naked"],
  ["Yamaha", "FZ1", 998, "Naked"],
  ["Kawasaki", "Z650", 649, "Naked"],
  ["Kawasaki", "Z900", 948, "Naked"],
  ["Kawasaki", "Z400", 399, "Naked"],
  ["Kawasaki", "Z125", 125, "Naked"],
  ["Kawasaki", "Z H2", 998, "Naked"],
  ["Kawasaki", "Ninja 400", 399, "Sport"],
  ["Kawasaki", "Ninja 650", 649, "Sport"],
  ["Kawasaki", "Ninja ZX-6R", 636, "Sport"],
  ["Kawasaki", "Ninja ZX-10R", 998, "Sport"],
  ["Kawasaki", "Ninja ZX-14R", 1441, "Sport"],
  ["Kawasaki", "Ninja 1000", 1043, "Sport"],
  ["Kawasaki", "Vulcan S", 649, "Cruiser"],
  ["Kawasaki", "Versys 650", 649, "Adventure"],
  ["Kawasaki", "Versys 1000", 1043, "Adventure"],
  ["Kawasaki", "KLX230", 233, "Offroad"],
  ["Kawasaki", "KLX300", 292, "Offroad"],
  ["Kawasaki", "W800", 773, "Classic"],
  ["Kawasaki", "KLR650", 652, "Adventure"],
  ["Kawasaki", "Ninja 300", 296, "Sport"],
  ["Kawasaki", "Z1000", 1043, "Naked"],
  ["Kawasaki", "Eliminator", 451, "Cruiser"],
  ["Kawasaki", "Ninja H2", 998, "Sport"],
  ["Suzuki", "SV650", 645, "Naked"],
  ["Suzuki", "SV1000", 996, "Naked"],
  ["Suzuki", "GSX-R750", 750, "Sport"],
  ["Suzuki", "GSX-R600", 599, "Sport"],
  ["Suzuki", "GSX-R1000", 999, "Sport"],
  ["Suzuki", "GSX-S750", 749, "Naked"],
  ["Suzuki", "GSX-S1000", 999, "Naked"],
  ["Suzuki", "GSX-8R", 776, "Sport"],
  ["Suzuki", "V-Strom 650", 645, "Adventure"],
  ["Suzuki", "V-Strom 800", 776, "Adventure"],
  ["Suzuki", "Hayabusa", 1340, "Sport"],
  ["Suzuki", "DR-Z400", 398, "Offroad"],
  ["Suzuki", "DR650", 644, "Offroad"],
  ["Suzuki", "Burgman 400", 400, "Scooter"],
  ["Suzuki", "Katana", 999, "Naked"],
  ["Suzuki", "GSX-8S", 776, "Naked"],
  ["Suzuki", "SV650X", 645, "Naked"],
  ["Suzuki", "Bandit 1250", 1255, "Naked"],
  ["Suzuki", "V-Strom 1050", 1037, "Adventure"],
  ["Ducati", "Monster", 937, "Naked"],
  ["Ducati", "Monster 821", 821, "Naked"],
  ["Ducati", "Panigale V2", 955, "Sport"],
  ["Ducati", "Panigale V4", 1103, "Sport"],
  ["Ducati", "Scrambler", 803, "Naked"],
  ["Ducati", "Multistrada V2", 937, "Adventure"],
  ["Ducati", "Multistrada V4", 1158, "Adventure"],
  ["Ducati", "Hypermotard", 937, "Supermoto"],
  ["Ducati", "Diavel", 1262, "Cruiser"],
  ["Ducati", "Streetfighter V2", 955, "Naked"],
  ["Ducati", "Streetfighter V4", 1103, "Naked"],
  ["Ducati", "SuperSport", 937, "Sport"],
  ["Ducati", "DesertX", 937, "Adventure"],
  ["Triumph", "Street Triple", 765, "Naked"],
  ["Triumph", "Speed Triple", 1160, "Naked"],
  ["Triumph", "Bonneville T120", 1200, "Classic"],
  ["Triumph", "Bonneville T100", 900, "Classic"],
  ["Triumph", "Thruxton", 1200, "Classic"],
  ["Triumph", "Scrambler 900", 900, "Classic"],
  ["Triumph", "Scrambler 1200", 1200, "Classic"],
  ["Triumph", "Tiger 900", 888, "Adventure"],
  ["Triumph", "Tiger 1200", 1160, "Adventure"],
  ["Triumph", "Trident 660", 660, "Naked"],
  ["Triumph", "Rocket 3", 2458, "Cruiser"],
  ["Triumph", "Speed Twin", 1200, "Classic"],
  ["Triumph", "Daytona 675", 675, "Sport"],
  ["BMW", "R 1250 GS", 1254, "Adventure"],
  ["BMW", "R 1300 GS", 1300, "Adventure"],
  ["BMW", "S 1000 RR", 999, "Sport"],
  ["BMW", "S 1000 R", 999, "Naked"],
  ["BMW", "F 900 R", 895, "Naked"],
  ["BMW", "F 900 GS", 895, "Adventure"],
  ["BMW", "G 310 R", 313, "Naked"],
  ["BMW", "G 310 GS", 313, "Adventure"],
  ["BMW", "R nineT", 1170, "Naked"],
  ["BMW", "F 850 GS", 853, "Adventure"],
  ["BMW", "K 1600 GT", 1649, "Touring"],
  ["BMW", "R 18", 1802, "Cruiser"],
  ["BMW", "S 1000 XR", 999, "Adventure"],
  ["KTM", "390 Duke", 373, "Naked"],
  ["KTM", "890 Duke", 889, "Naked"],
  ["KTM", "1290 Super Duke", 1301, "Naked"],
  ["KTM", "790 Adventure", 799, "Adventure"],
  ["KTM", "890 Adventure", 889, "Adventure"],
  ["KTM", "390 Adventure", 373, "Adventure"],
  ["KTM", "RC 390", 373, "Sport"],
  ["KTM", "690 SMC R", 693, "Supermoto"],
  ["KTM", "1290 Super Adventure", 1301, "Adventure"],
  ["KTM", "250 Duke", 248, "Naked"],
  ["Harley-Davidson", "Sportster S", 1252, "Cruiser"],
  ["Harley-Davidson", "Iron 883", 883, "Cruiser"],
  ["Harley-Davidson", "Street Glide", 1868, "Touring"],
  ["Harley-Davidson", "Road Glide", 1868, "Touring"],
  ["Harley-Davidson", "Fat Boy", 1868, "Cruiser"],
  ["Harley-Davidson", "Pan America", 1252, "Adventure"],
  ["Harley-Davidson", "Nightster", 975, "Cruiser"],
  ["Harley-Davidson", "Low Rider S", 1868, "Cruiser"],
  ["Harley-Davidson", "Fat Bob", 1868, "Cruiser"],
  ["Harley-Davidson", "Street Bob", 1868, "Cruiser"],
  ["Aprilia", "RS 660", 659, "Sport"],
  ["Aprilia", "Tuono 660", 659, "Naked"],
  ["Aprilia", "RSV4", 1099, "Sport"],
  ["Aprilia", "Tuono V4", 1077, "Naked"],
  ["Aprilia", "Tuareg 660", 659, "Adventure"],
  ["Indian", "Scout", 1133, "Cruiser"],
  ["Indian", "Scout Bobber", 1133, "Cruiser"],
  ["Indian", "Chief", 1890, "Cruiser"],
  ["Indian", "FTR", 1203, "Naked"],
  ["Indian", "Pursuit", 1768, "Touring"],
  ["Royal Enfield", "Classic 350", 349, "Classic"],
  ["Royal Enfield", "Hunter 350", 349, "Classic"],
  ["Royal Enfield", "Meteor 350", 349, "Cruiser"],
  ["Royal Enfield", "Himalayan", 411, "Adventure"],
  ["Royal Enfield", "INT650", 648, "Classic"],
  ["Royal Enfield", "Continental GT", 648, "Classic"],
  ["Royal Enfield", "Super Meteor 650", 648, "Cruiser"],
  ["Moto Guzzi", "V7", 853, "Classic"],
  ["Moto Guzzi", "V85 TT", 853, "Adventure"],
  ["Moto Guzzi", "V9 Bobber", 853, "Cruiser"],
  ["Moto Guzzi", "V100 Mandello", 1042, "Touring"],
  ["MV Agusta", "F3 800", 798, "Sport"],
  ["MV Agusta", "Brutale 800", 798, "Naked"],
  ["MV Agusta", "Turismo Veloce", 798, "Touring"],
  ["MV Agusta", "Dragster 800", 798, "Naked"],
  ["Husqvarna", "Svartpilen 401", 373, "Naked"],
  ["Husqvarna", "Vitpilen 401", 373, "Naked"],
  ["Husqvarna", "Norden 901", 889, "Adventure"],
  ["Husqvarna", "701 Enduro", 693, "Offroad"],
  ["Husqvarna", "701 Supermoto", 693, "Supermoto"],
  ["CFMoto", "300NK", 292, "Naked"],
  ["CFMoto", "450NK", 449, "Naked"],
  ["CFMoto", "700CL-X", 693, "Naked"],
  ["CFMoto", "800NK", 799, "Naked"],
  ["CFMoto", "450SS", 449, "Sport"],
  ["Benelli", "TRK 502", 500, "Adventure"],
  ["Benelli", "752S", 754, "Naked"],
  ["Benelli", "Leoncino", 500, "Classic"],
  ["Benelli", "TNT 600", 600, "Naked"],
];

function slug(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function aliasesFor(make, model) {
  const folded = model.toLowerCase();
  const squeezed = folded.replace(/[^a-z0-9]+/g, "");
  const spaced = folded.replace(/[^a-z0-9]+/g, " ").trim();
  const out = new Set([squeezed, spaced, `${make.toLowerCase()} ${spaced}`]);
  return [...out].filter(Boolean);
}

function bikezUrl(make, model, year) {
  return `https://bikez.com/motorcycles/${slug(make)}_${slug(model)}_${year}.php`;
}

function makeBike(make, model, year, cc, category, extra = {}) {
  const id = extra.id || `${slug(make)}-${slug(model)}-${year}`;
  return {
    id,
    make,
    model,
    year,
    years: extra.years || [year],
    cc,
    category,
    aliases: extra.aliases || aliasesFor(make, model),
    thumb: extra.thumb || `store/img/collection/${id}-thumb.webp`,
    image: extra.image || `store/img/collection/${id}.webp`,
    bikez: extra.bikez || bikezUrl(make, model, year),
    manualId: extra.manualId ?? null,
  };
}

const REQUIRED = [
  makeBike("Ducati", "Monster", 2019, 937, "Naked", {
    aliases: ["monster", "ducati monster", "monster 821"],
  }),
  makeBike("Kawasaki", "Ninja 400", 2018, 399, "Sport", {
    aliases: ["ninja400", "ninja 400", "ex400"],
  }),
];

const reserved = new Set([...FLAGSHIP, ...REQUIRED].map((b) => b.id));
const bikes = [...FLAGSHIP.map((b) => ({ ...b })), ...REQUIRED.map((b) => ({ ...b }))];
const YEARS = [];
for (let y = 2008; y <= 2025; y++) YEARS.push(y);

for (const [make, model, cc, category] of MODELS) {
  for (const year of YEARS) {
    if (bikes.length - FLAGSHIP.length >= 1000) break;
    const id = `${slug(make)}-${slug(model)}-${year}`;
    if (reserved.has(id)) continue;
    bikes.push(makeBike(make, model, year, cc, category));
  }
  if (bikes.length - FLAGSHIP.length >= 1000) break;
}

const synthetic = bikes.length - FLAGSHIP.length;
if (synthetic < 1000) {
  throw new Error(`only generated ${synthetic} synthetic bikes`);
}

const out = { bikes };
const dir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(dir, "collection.sample.json"), JSON.stringify(out));
console.log(`wrote ${bikes.length} bikes (${synthetic} synthetic + ${FLAGSHIP.length} manuals)`);
