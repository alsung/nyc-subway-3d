// src/data/embedded.js
// Hardcoded fallback data — lets the app render with zero network requests.
// Coordinates are real WGS-84 values. Used by gtfs-loader.js when /gtfs/ files
// are unavailable.

export const EMBEDDED_STATIONS = [
    { id: '101',  name: 'Van Cortlandt Park-242 St',      lat: 40.88922, lng: -73.89836 },
    { id: '401',  name: 'Woodlawn',                       lat: 40.88556, lng: -73.87842 },
    { id: '601',  name: 'Pelham Bay Park',                lat: 40.85550, lng: -73.82793 },
    { id: 'D01',  name: 'Norwood-205 St',                 lat: 40.87454, lng: -73.87835 },
    { id: 'A02',  name: 'Inwood-207 St',                  lat: 40.86803, lng: -73.92098 },
    { id: '127',  name: 'Times Sq-42 St',                 lat: 40.75529, lng: -73.98794 },
    { id: '631',  name: 'Grand Central-42 St',            lat: 40.75222, lng: -73.97675 },
    { id: '725',  name: '34 St-Hudson Yards',             lat: 40.75530, lng: -74.00200 },
    { id: '702',  name: 'Flushing-Main St',               lat: 40.75952, lng: -73.83001 },
    { id: 'B08',  name: 'Jackson Heights-Roosevelt Av',   lat: 40.74673, lng: -73.89148 },
    { id: 'G22',  name: 'Court Sq',                       lat: 40.74702, lng: -73.94521 },
    { id: 'A55',  name: 'Jay St-MetroTech',               lat: 40.69218, lng: -73.98690 },
    { id: 'A65',  name: 'Atlantic Av-Barclays Ctr',       lat: 40.68382, lng: -73.97756 },
    { id: 'L08',  name: 'Bedford Av',                     lat: 40.71716, lng: -73.95699 },
    { id: 'J12',  name: 'Jamaica Center-Parsons/Archer',  lat: 40.70217, lng: -73.80099 },
    { id: 'F01',  name: 'Jamaica-179 St',                 lat: 40.71259, lng: -73.79044 },
    { id: 'D43',  name: 'Coney Island-Stillwell Av',      lat: 40.57749, lng: -73.98101 },
    { id: 'R45',  name: 'Bay Ridge-95 St',                lat: 40.61600, lng: -74.03019 },
    { id: 'L29',  name: 'Canarsie-Rockaway Pkwy',         lat: 40.64637, lng: -73.90177 },
    { id: 'H11',  name: 'Far Rockaway-Mott Av',           lat: 40.60497, lng: -73.75589 },
    { id: 'SI1',  name: 'St. George',                     lat: 40.64350, lng: -74.07352 },
]

export const EMBEDDED_ROUTES = [
    { id: '1',  shortName: '1',  name: 'Broadway-7 Av Local',       color: '#EE352E', textColor: '#FFFFFF' },
    { id: '2',  shortName: '2',  name: '7 Av Express',              color: '#EE352E', textColor: '#FFFFFF' },
    { id: '3',  shortName: '3',  name: '7 Av Express',              color: '#EE352E', textColor: '#FFFFFF' },
    { id: '4',  shortName: '4',  name: 'Lexington Av Express',      color: '#00933C', textColor: '#FFFFFF' },
    { id: '5',  shortName: '5',  name: 'Lexington Av Express',      color: '#00933C', textColor: '#FFFFFF' },
    { id: '6',  shortName: '6',  name: 'Lexington Av Local',        color: '#00933C', textColor: '#FFFFFF' },
    { id: '7',  shortName: '7',  name: 'Flushing Local',            color: '#B933AD', textColor: '#FFFFFF' },
    { id: 'A',  shortName: 'A',  name: '8 Av Express',              color: '#2850AD', textColor: '#FFFFFF' },
    { id: 'C',  shortName: 'C',  name: '8 Av Local',                color: '#2850AD', textColor: '#FFFFFF' },
    { id: 'E',  shortName: 'E',  name: '8 Av Local',                color: '#2850AD', textColor: '#FFFFFF' },
    { id: 'B',  shortName: 'B',  name: '6 Av Express',              color: '#FF6319', textColor: '#FFFFFF' },
    { id: 'D',  shortName: 'D',  name: '6 Av Express',              color: '#FF6319', textColor: '#FFFFFF' },
    { id: 'F',  shortName: 'F',  name: '6 Av Local',                color: '#FF6319', textColor: '#FFFFFF' },
    { id: 'M',  shortName: 'M',  name: '6 Av Local',                color: '#FF6319', textColor: '#FFFFFF' },
    { id: 'G',  shortName: 'G',  name: 'Brooklyn-Queens Crosstown', color: '#6CBE45', textColor: '#FFFFFF' },
    { id: 'J',  shortName: 'J',  name: 'Nassau St Local',           color: '#996633', textColor: '#FFFFFF' },
    { id: 'Z',  shortName: 'Z',  name: 'Nassau St Express',         color: '#996633', textColor: '#FFFFFF' },
    { id: 'L',  shortName: 'L',  name: '14 St-Canarsie Local',      color: '#A7A9AC', textColor: '#000000' },
    { id: 'N',  shortName: 'N',  name: 'Broadway Express',          color: '#FCCC0A', textColor: '#000000' },
    { id: 'Q',  shortName: 'Q',  name: 'Broadway Express',          color: '#FCCC0A', textColor: '#000000' },
    { id: 'R',  shortName: 'R',  name: 'Broadway Local',            color: '#FCCC0A', textColor: '#000000' },
    { id: 'W',  shortName: 'W',  name: 'Broadway Local',            color: '#FCCC0A', textColor: '#000000' },
    { id: 'GS', shortName: 'S',  name: '42 St Shuttle',             color: '#808183', textColor: '#FFFFFF' },
    { id: 'SI', shortName: 'SI', name: 'Staten Island Railway',     color: '#808183', textColor: '#FFFFFF' },
]

export const EMBEDDED_SHAPES = {
    '1': [
        [40.88922, -73.89836],  // Van Cortlandt Park-242 St
        [40.86113, -73.90816],  // 225 St area
        [40.85172, -73.93609],  // Dyckman St
        [40.83990, -73.93944],  // 168 St
        [40.82388, -73.94545],  // 145 St
        [40.81098, -73.95036],  // 125 St
        [40.79650, -73.97091],  // 96 St
        [40.76812, -73.98190],  // 59 St-Columbus Circle
        [40.75529, -73.98794],  // Times Sq-42 St
        [40.74991, -73.99108],  // 34 St-Penn Station
        [40.73244, -73.99726],  // 14 St
        [40.70963, -74.01393],  // Chambers St
        [40.70167, -74.01374],  // South Ferry
    ],
    '2': [
        [40.88327, -73.84323],  // Wakefield-241 St
        [40.86601, -73.87806],  // 233 St area
        [40.84451, -73.91527],  // 149 St-Grand Concourse
        [40.82388, -73.94545],  // 145 St
        [40.81098, -73.95036],  // 125 St
        [40.75529, -73.98794],  // Times Sq-42 St
        [40.74991, -73.99108],  // 34 St-Penn Station
        [40.73244, -73.99726],  // 14 St
        [40.70963, -74.01393],  // Chambers St
        [40.68382, -73.97756],  // Atlantic Av-Barclays Ctr
        [40.66514, -73.94560],  // Church Av area
        [40.65141, -73.94977],  // Flatbush Av-Brooklyn College
    ],
    '3': [
        [40.82388, -73.94545],  // 148 St (northern terminus)
        [40.81098, -73.95036],  // 125 St
        [40.75529, -73.98794],  // Times Sq-42 St
        [40.74991, -73.99108],  // 34 St-Penn Station
        [40.73244, -73.99726],  // 14 St
        [40.70963, -74.01393],  // Chambers St
        [40.68382, -73.97756],  // Atlantic Av-Barclays Ctr
        [40.66899, -73.93287],  // Saratoga Av area
        [40.66471, -73.90452],  // New Lots Av
    ],
    '4': [
        [40.88556, -73.87842],  // Woodlawn
        [40.85671, -73.89394],  // Bedford Park Blvd
        [40.82771, -73.92362],  // 161 St-Yankee Stadium
        [40.81514, -73.92525],  // 149 St-Grand Concourse
        [40.75222, -73.97675],  // Grand Central-42 St
        [40.73244, -73.98995],  // 14 St-Union Sq
        [40.71279, -74.00707],  // Fulton St
        [40.68382, -73.97756],  // Atlantic Av-Barclays Ctr
        [40.67027, -73.94990],  // Crown Heights-Utica Av
        [40.66224, -73.92412],  // New Lots Av
    ],
    '5': [
        [40.88781, -73.82696],  // Eastchester-Dyre Av
        [40.85671, -73.89394],  // Bedford Park Blvd
        [40.82771, -73.92362],  // 161 St-Yankee Stadium
        [40.75222, -73.97675],  // Grand Central-42 St
        [40.73244, -73.98995],  // 14 St-Union Sq
        [40.71279, -74.00707],  // Fulton St
        [40.68382, -73.97756],  // Atlantic Av-Barclays Ctr
        [40.65141, -73.94977],  // Flatbush Av-Brooklyn College
    ],
    '6': [
        [40.85550, -73.82793],  // Pelham Bay Park
        [40.82362, -73.87454],  // Buhre Av area
        [40.80297, -73.91073],  // 138 St-Grand Concourse area
        [40.79321, -73.94207],  // 125 St
        [40.75222, -73.97675],  // Grand Central-42 St
        [40.73244, -73.98995],  // 14 St-Union Sq
        [40.71279, -74.00707],  // Fulton St
        [40.70861, -74.00418],  // Brooklyn Bridge-City Hall
    ],
    '7': [
        [40.75952, -73.83001],  // Flushing-Main St
        [40.74673, -73.89148],  // Jackson Heights-Roosevelt Av
        [40.74390, -73.94415],  // Queensboro Plaza
        [40.75222, -73.97675],  // 5 Av
        [40.75529, -73.98794],  // Times Sq-42 St
        [40.75530, -74.00200],  // 34 St-Hudson Yards
    ],
    'A': [
        [40.86803, -73.92098],  // Inwood-207 St
        [40.83532, -73.93304],  // 181 St
        [40.81600, -73.94498],  // 145 St
        [40.75778, -73.98959],  // 42 St-Port Authority
        [40.71271, -74.00999],  // WTC/Chambers St
        [40.68382, -73.97756],  // Atlantic Av-Barclays Ctr
        [40.64875, -73.95431],  // Utica Av area
        [40.61600, -73.82028],  // Ozone Park-Lefferts split
        [40.60497, -73.75589],  // Far Rockaway-Mott Av
    ],
    'C': [
        [40.83990, -73.93944],  // 168 St
        [40.81600, -73.94498],  // 145 St
        [40.75778, -73.98959],  // 42 St-Port Authority
        [40.71271, -74.00999],  // WTC/Chambers St
        [40.68836, -73.98381],  // Hoyt-Schermerhorn Sts
        [40.65933, -73.94321],  // Euclid Av
    ],
    'E': [
        [40.70217, -73.80099],  // Jamaica Center
        [40.73513, -73.86644],  // Kew Gardens-Union Tpke area
        [40.74673, -73.89148],  // Jackson Heights-Roosevelt Av
        [40.74882, -73.97134],  // 5 Av-53 St
        [40.75395, -73.98985],  // 42 St-Port Authority
        [40.72194, -74.00020],  // Canal St
        [40.71271, -74.00999],  // WTC/Chambers St
    ],
    'B': [
        [40.82388, -73.94545],  // 145 St
        [40.79862, -73.95527],  // 96 St (CPW)
        [40.76489, -73.98043],  // 47-50 Sts-Rockefeller Ctr
        [40.75258, -73.97745],  // 42 St-Bryant Park
        [40.72229, -73.99738],  // W 4 St-Washington Sq
        [40.71053, -73.99480],  // Broadway-Lafayette St
        [40.69169, -73.99047],  // DeKalb Av
        [40.64460, -73.96109],  // Newkirk Av area
        [40.58055, -73.96184],  // Brighton Beach
    ],
    'D': [
        [40.87454, -73.87835],  // Norwood-205 St
        [40.82842, -73.92155],  // 161 St-Yankee Stadium area
        [40.76489, -73.98043],  // 47-50 Sts-Rockefeller Ctr
        [40.75258, -73.97745],  // 42 St-Bryant Park
        [40.72229, -73.99738],  // W 4 St
        [40.69169, -73.99047],  // DeKalb Av
        [40.64920, -73.96926],  // Church Av area
        [40.57749, -73.98101],  // Coney Island-Stillwell Av
    ],
    'F': [
        [40.71259, -73.79044],  // Jamaica-179 St
        [40.73513, -73.86644],  // Kew Gardens-Union Tpke area
        [40.74673, -73.89148],  // Jackson Heights-Roosevelt Av
        [40.75258, -73.97745],  // 42 St-Bryant Park
        [40.72229, -73.99738],  // W 4 St
        [40.71053, -73.99480],  // Broadway-Lafayette St
        [40.68458, -73.97624],  // Bergen St area
        [40.57749, -73.98101],  // Coney Island-Stillwell Av
    ],
    'M': [
        [40.71025, -73.84685],  // Forest Hills-71 Av
        [40.74673, -73.89148],  // Jackson Heights-Roosevelt Av
        [40.76489, -73.98043],  // 47-50 Sts-Rockefeller Ctr
        [40.75258, -73.97745],  // 42 St-Bryant Park
        [40.72229, -73.99738],  // W 4 St
        [40.71053, -73.99480],  // Broadway-Lafayette St
        [40.71302, -73.97041],  // Metropolitan Av (Brooklyn)
    ],
    'G': [
        [40.74702, -73.94521],  // Court Sq
        [40.72238, -73.94385],  // Greenpoint Av
        [40.71820, -73.95048],  // Nassau Av
        [40.70020, -73.95038],  // Myrtle-Willoughby Avs
        [40.68946, -73.96640],  // Fulton St (Brooklyn)
        [40.66983, -73.97527],  // 7 Av area
        [40.65401, -73.97535],  // Church Av
    ],
    'J': [
        [40.70217, -73.80099],  // Jamaica Center
        [40.68556, -73.85261],  // 121 St area
        [40.65844, -73.90685],  // 104 St area
        [40.68312, -73.93866],  // Cypress Hills
        [40.71043, -73.99695],  // Marcy Av
        [40.70718, -74.00909],  // Broad St
    ],
    'Z': [
        [40.70217, -73.80099],  // Jamaica Center
        [40.68312, -73.93866],  // Cypress Hills
        [40.71043, -73.99695],  // Marcy Av
        [40.70718, -74.00909],  // Broad St
    ],
    'L': [
        [40.73979, -74.00150],  // 8 Av
        [40.73542, -73.98690],  // 14 St-Union Sq
        [40.71716, -73.95699],  // Bedford Av
        [40.70818, -73.93045],  // Lorimer St area
        [40.67691, -73.90465],  // Bushwick-Aberdeen area
        [40.64637, -73.90177],  // Canarsie-Rockaway Pkwy
    ],
    'N': [
        [40.77480, -73.91203],  // Astoria-Ditmars Blvd
        [40.75437, -73.93042],  // Queensboro Plaza
        [40.75258, -73.97745],  // Times Sq area
        [40.74296, -73.98845],  // 34 St-Herald Sq
        [40.73244, -73.98995],  // 14 St-Union Sq
        [40.71951, -73.99640],  // Canal St
        [40.68382, -73.97756],  // Atlantic Av-Barclays Ctr
        [40.64460, -73.96109],  // Ditmas Av area
        [40.57749, -73.98101],  // Coney Island-Stillwell Av
    ],
    'Q': [
        [40.78453, -73.94967],  // 96 St (2nd Av)
        [40.75258, -73.97745],  // Times Sq area
        [40.74296, -73.98845],  // 34 St-Herald Sq
        [40.73244, -73.98995],  // 14 St-Union Sq
        [40.71951, -73.99640],  // Canal St
        [40.70258, -73.99702],  // Whitehall St
        [40.68382, -73.97756],  // Atlantic Av-Barclays Ctr
        [40.58055, -73.96184],  // Brighton Beach
        [40.57749, -73.98101],  // Coney Island-Stillwell Av
    ],
    'R': [
        [40.71025, -73.84685],  // Forest Hills-71 Av
        [40.74882, -73.97134],  // 5 Av-59 St
        [40.74296, -73.98845],  // 34 St-Herald Sq
        [40.73244, -73.98995],  // 14 St-Union Sq
        [40.71951, -73.99640],  // Canal St
        [40.70258, -73.99702],  // Whitehall St
        [40.68382, -73.97756],  // Atlantic Av-Barclays Ctr
        [40.63551, -74.01367],  // 77 St area
        [40.61600, -74.03019],  // Bay Ridge-95 St
    ],
    'W': [
        [40.77480, -73.91203],  // Astoria-Ditmars Blvd
        [40.75437, -73.93042],  // Queensboro Plaza
        [40.75258, -73.97745],  // Times Sq area
        [40.74296, -73.98845],  // 34 St-Herald Sq
        [40.73244, -73.98995],  // 14 St-Union Sq
        [40.71951, -73.99640],  // Canal St
        [40.70258, -73.99702],  // Whitehall St
    ],
    'GS': [
        [40.75529, -73.98794],  // Times Sq-42 St
        [40.75222, -73.97675],  // Grand Central-42 St
    ],
    'SI': [
        [40.64350, -74.07352],  // St. George
        [40.60182, -74.10850],  // New Dorp area
        [40.56160, -74.18509],  // Richmond Valley area
        [40.51200, -74.25160],  // Tottenville
    ],
}
