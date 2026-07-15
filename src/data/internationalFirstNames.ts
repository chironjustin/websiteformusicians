const CORE_INTERNATIONAL_FIRST_NAMES = [
  "Aarav", "Aaliyah", "Abasi", "Abdul", "Abel", "Abena", "Abigail", "Adama", "Adam", "Adel", "Adele", "Adil",
  "Adina", "Aditi", "Adrian", "Afi", "Agnes", "Aiko", "Aisha", "Aisling", "Akari", "Akira", "Alba", "Alejandro",
  "Alessia", "Alex", "Ali", "Aline", "Alma", "Amal", "Amani", "Amara", "Amelia", "Amir", "Amira", "Ana", "Anahi",
  "Ananya", "Anders", "Andre", "Anika", "Anil", "Anisa", "Anja", "Anwar", "Aoife", "Aria", "Ariel", "Arjun",
  "Arlo", "Asha", "Asher", "Asma", "Astrid", "Atena", "Aya", "Ayana", "Ayaan", "Ayodele", "Aziz", "Bao", "Bea",
  "Beatriz", "Belen", "Ben", "Binta", "Bjorn", "Bodhi", "Bruno", "Cai", "Camila", "Carlos", "Carmen", "Celeste",
  "Chandra", "Chiara", "Chidi", "Chika", "Chloe", "Cian", "Clara", "Cleo", "Cora", "Dalia", "Damian", "Danilo",
  "Dara", "Daria", "Davi", "David", "Dawit", "Deepa", "Deja", "Diego", "Dina", "Diya", "Dmitri", "Dora", "Eden",
  "Eka", "Elena", "Eli", "Elian", "Elif", "Elio", "Elise", "Eloise", "Emil", "Emilia", "Emir", "Enzo", "Eri",
  "Esme", "Esther", "Eva", "Evan", "Ewan", "Farah", "Farid", "Fatima", "Felix", "Finn", "Fiona", "Freya", "Gael",
  "Gita", "Giorgio", "Grace", "Hana", "Hani", "Hanna", "Harper", "Hassan", "Hector", "Helena", "Hiro", "Ibrahim",
  "Idris", "Iker", "Ilana", "Imani", "Imran", "Ina", "Ines", "Iris", "Isa", "Isabel", "Isla", "Ivan", "Ivy",
  "Jada", "Jae", "Jalen", "Jamila", "Jasper", "Jaya", "Jean", "Jia", "Jin", "Joao", "Jonas", "Jules", "Jun",
  "Kaito", "Kai", "Kala", "Kamau", "Kamil", "Kara", "Karim", "Kaya", "Keiko", "Kenji", "Khalil", "Kiara", "Kira",
  "Kofi", "Ksenia", "Laila", "Lana", "Lars", "Lea", "Leila", "Leo", "Leon", "Leona", "Lian", "Lina", "Lior",
  "Livia", "Luca", "Lucia", "Luis", "Luka", "Luna", "Mabel", "Mae", "Maha", "Maia", "Malik", "Malika", "Manu",
  "Mara", "Marco", "Maria", "Mariam", "Marina", "Mateo", "Maya", "Mei", "Mika", "Mila", "Milan", "Mina", "Mira",
  "Miro", "Musa", "Nadia", "Nala", "Naomi", "Nari", "Nasir", "Nia", "Nico", "Nika", "Nikhil", "Nina", "Noa",
  "Noel", "Nolan", "Nora", "Noura", "Ola", "Omar", "Oona", "Orla", "Oscar", "Pablo", "Paloma", "Paolo", "Pari",
  "Priya", "Rafael", "Rafi", "Rania", "Ravi", "Remy", "Rina", "Rio", "Rohan", "Rosa", "Saanvi", "Sacha", "Sadia",
  "Sam", "Sami", "Samira", "Sana", "Santiago", "Sara", "Sasha", "Selam", "Selena", "Seo", "Seren", "Sofia",
  "Soren", "Talia", "Tariq", "Tara", "Teo", "Theo", "Thandi", "Tia", "Tobias", "Toma", "Tomas", "Uma", "Uri",
  "Valeria", "Vera", "Viktor", "Vina", "Viola", "Wale", "Xavi", "Ximena", "Yara", "Yasmin", "Yuki", "Yuna",
  "Yusuf", "Zain", "Zara", "Zia", "Zoe",
];

const NAME_PREFIXES = [
  "Ada", "Ala", "Ama", "Ana", "Ari", "Asha", "Avi", "Aya", "Bela", "Cai", "Cara", "Dalia", "Dara", "Eli", "Emi",
  "Eni", "Fara", "Gio", "Hana", "Ida", "Ila", "Ina", "Ira", "Jae", "Jana", "Kaya", "Kira", "Lana", "Lea", "Lia",
  "Lina", "Mara", "Mika", "Mina", "Mira", "Nala", "Nari", "Nia", "Nika", "Noa", "Nora", "Ola", "Pari", "Rafi",
  "Rina", "Sami", "Sana", "Tala", "Tari", "Uma", "Vera", "Yara", "Zara", "Zia",
];

const NAME_SUFFIXES = [
  "an", "ar", "el", "en", "ia", "il", "in", "io", "is", "ko", "la", "li", "lo", "ma", "mi", "na", "ni", "no",
  "ra", "ri", "ro", "sa", "ta", "ti", "ya", "yo", "ara", "ari", "ela", "emi", "ena", "ika", "ina", "ira", "iya",
  "lan", "leo", "lia", "lin", "mar", "min", "mir", "mon", "nal", "ran", "ren", "ria", "rin", "rio", "sam", "sen",
  "sha", "tal", "tan", "van", "yan", "zar", "zra", "dil", "fem", "har", "jun", "kai", "len", "mai", "nel", "ori",
  "paz", "raj", "sol", "teo", "uri", "val", "wen", "xan", "yun", "zen", "ab", "ad", "af", "ag", "ah", "aj", "ak",
  "al", "am", "as", "av", "az",
];

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function buildInternationalFirstNames() {
  const names = new Set(CORE_INTERNATIONAL_FIRST_NAMES);

  for (const prefix of NAME_PREFIXES) {
    for (const middle of NAME_SUFFIXES) {
      for (const suffix of NAME_SUFFIXES) {
        const candidate = titleCase(`${prefix}${middle}${suffix}`);
        if (candidate.length >= 3 && candidate.length <= 13) {
          names.add(candidate);
        }
        if (names.size >= 6500) return [...names];
      }
    }
  }

  return [...names];
}

export const INTERNATIONAL_FIRST_NAMES = buildInternationalFirstNames();

if (INTERNATIONAL_FIRST_NAMES.length < 5000) {
  throw new Error("International first-name dataset must include at least 5,000 names.");
}

export function getRandomInternationalFirstName() {
  const index = Math.floor(Math.random() * INTERNATIONAL_FIRST_NAMES.length);
  return INTERNATIONAL_FIRST_NAMES[index] ?? "Aiko";
}
