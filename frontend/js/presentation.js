// frontend/js/presentation.js

let currentMunicipalityIndex = 0;

// LIST OF MUNICIPALITIES (we will rotate through these)
const municipalities = [
  { name: "Pickering", bbox: [-79.1, 43.8, -78.9, 43.9] },
  { name: "Ajax", bbox: [-79.05, 43.83, -78.95, 43.88] },
  { name: "Whitby", bbox: [-78.98, 43.84, -78.92, 43.90] },
  { name: "Oshawa", bbox: [-78.93, 43.85, -78.83, 43.95] },
  { name: "Uxbridge", bbox: [-79.15, 44.07, -79.0, 44.15] },
  { name: "Brock", bbox: [-79.2, 44.3, -78.9, 44.5] },
  { name: "Scugog", bbox: [-79.25, 44.1, -78.95, 44.3] },
  { name: "Clarington", bbox: [-78.9, 43.85, -78.3, 44.2] }
];

// THIS STARTS THE PRESENTATION MODE
window.startPresentation = function () {
  showMunicipality();

  if (window.presentationInterval) {
    clearInterval(window.presentationInterval);
  }

  window.presentationInterval = setInterval(() => {
    currentMunicipalityIndex =
      (currentMunicipalityIndex + 1) % municipalities.length;
    showMunicipality();
  }, 25000);
};


// DISPLAYS ONE MUNICIPALITY
function showMunicipality() {
  const municipality = municipalities[currentMunicipalityIndex];

  // Update title
  document.getElementById("presentation-title").innerText =
    municipality.name;

  // Tell the map to zoom
  window.zoomToMunicipality(municipality.bbox);

  // Filter vehicles on map
  window.showVehiclesInBBox(municipality.bbox);

  loadAlerts(municipality.name);
}
