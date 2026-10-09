// Fake roster for local development. Deterministic so links stay stable between runs.
const FIRST = ['Avery', 'Jordan', 'Riley', 'Sam', 'Maya', 'Leo', 'Zoe', 'Eli', 'Nora', 'Kai', 'Ivy', 'Owen',
  'Ruby', 'Theo', 'Luna', 'Max', 'Ada', 'Finn', 'Isla', 'Milo'];
const LAST = ['Garcia', 'Nguyen', 'Smith', 'Patel', 'Kim', 'Lopez', 'Brown', 'Chen', 'Davis', 'Moore'];
const CLASSES = [
  ['K', 'Ms. Rivera'], ['1', 'Mrs. Okafor'], ['2', 'Mr. Lindqvist'],
  ['3', 'Ms. Tanaka'], ['3', 'Mr. Chen'], ['4', 'Mrs. Alvarez'], ['5', 'Mr. Brooks'],
];

function buildRoster() {
  const rows = [];
  let id = 1001;
  CLASSES.forEach(([grade, teacher], c) => {
    for (let i = 0; i < 6; i++) {
      rows.push([String(id++), FIRST[(c * 6 + i) % FIRST.length], LAST[(c * 3 + i) % LAST.length], grade, teacher]);
    }
  });
  return { headers: ['Student ID', 'First Name', 'Last Name', 'Grade', 'Teacher'], rows };
}

module.exports = { buildRoster };
