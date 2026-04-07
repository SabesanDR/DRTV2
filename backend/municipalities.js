//backend/municipalitird.js
const municipalityRoutes = {
    "Pickering": ["101", "112", "121", "211",
        "900", "901", "902", "905", "915", "916", "917", "920", "921", "N1", "N2"
    ],
    "Whitby": ["211", "216", "224", "227",
        "900", "901", "902", "905", "915", "916", "917", "920", "921", "N1", "N2"
    ],
    "Ajax": ["301", "302", "306", "315", "319", "392",
        "900", "901", "902", "905", "915", "916", "917", "920", "921", "N1", "N2"
    ],
    "Oshawa": ["403", "405", "407", "409", "410", "411", "419", "421", "423",
        "900", "901", "902", "905", "915", "916", "917", "920", "921", "N1", "N2"
    ],
    "Clarington": ["502", "505", "507", 
        "900", "901", "902", "905", "915", "916", "917", "920", "921", "N1", "N2"
    ],
    "Brock": ["605", "618",
        "900", "901", "902", "905", "915", "916", "917", "920", "921", "N1", "N2"
    ],
    "Uxbridge": ["901", "902", "905", "915", "916", "917", "920", "921", "N1", "N2"
    ],
    "Scugog": ["901", "902", "905", "915", "916", "917", "920", "921", "N1", "N2"
    ]
};

function getRoutesForMunicipality(municipality) {
    return municipalityRoutes[municipality] || [];
}

function getAllMunicipalities() {
    return Object.keys(municipalityRoutes);
}

module.exports = {
    getRoutesForMunicipality,
    getAllMunicipalities
};