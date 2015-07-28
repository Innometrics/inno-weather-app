var util        = require('util'),
    asyncLib    = require('async'),
    express     = require('express'),
    bodyParser  = require('body-parser'),
    satelize    = require('satelize'),
    sqlite3     = require('sqlite3').verbose(),
    oWeather    = require('openweather-node'),
    Inno        = require('innometrics-helper');

var vars = {
    bucketName: "bucket1",
    appKey: "H9DPVSfh8IfaUbXA",
    appName: "innometrics-121",
    groupId: 4,
    apiUrl: "https://staging.innomdc.com",
    collectApp: "innometrics-121"
};

var wAppKey = "999551e1460674ec3787ba4f9c17d440";
var appRequestTimeout = 15000;

var WeatherApp = function (db) {
    this.clearProfileStack();
    this.db = db;
    this.processLock = false;
};

WeatherApp.prototype = {
    addProfileToStack: function (data, ip) {
        var profile = data.profile,
            session = data.session;

        this.profilesStack[profile.id + "|" + session.section] = ip;
    },

    getProfilesFromStack: function () {
        return this.profilesStack;
    },

    clearProfileStack: function () {
        this.profilesStack = {};
    },

    getCoordsByIp: function (ip, callback) {
        var self = this;
        this.getCoordByIpFromCache(ip, function (error, data) {
            if (error || !data) {
                console.log("Record was not found in cache");
                self.requestCoordsByIp(ip, callback);
            } else {
                console.log("Record was found in cache");
                callback(null, {latitude: data.latitude, longitude: data.longitude});
            }
        });
    },

    getCoordByIpFromCache: function (ip, callback) {
        this.db.get(util.format('SELECT * FROM geo_ip_cache WHERE ip="%s"', ip), callback);
    },

    addCoordsToCache: function (ip, geoData, callback) {
        var self = this;
        this.getCoordByIpFromCache(ip, function (error, data) {
            if (data) {
                self.db.run(util.format('UPDATE geo_ip_cache SET latitude="%s",longitude="%s" WHERE ip="%s"', geoData.latitude, geoData.longitude, ip));
            } else {
                self.db.run(util.format('INSERT INTO geo_ip_cache(ip, latitude, longitude) VALUES ("%s","%s","%s")', ip, geoData.latitude, geoData.longitude));
            }

            callback();
        });
    },

    getAllIpsFromCache: function (callback) {
        this.db.all('SELECT * FROM geo_ip_cache', function (error, data) {
            callback((!error && data) ? data : null);
        });
    },

    requestCoordsByIp: function (ip, callback) {
        var self = this;
        satelize.satelize({ip: ip}, function (error, geoData) {
            if (error) {
                callback(error);
            } else {
                try {
                    geoData = JSON.parse(geoData);
                } catch (e) {
                    geoData = null;
                }

                if (geoData) {
                    self.addCoordsToCache(ip, geoData, function () {
                        callback(null, {latitude: geoData.latitude, longitude: geoData.longitude});
                    });
                } else {
                    callback(new Error("Incorrect geo data"));
                }
            }
        });
    },

    addGeoDataToProfiles: function () {
        console.log("Start adding data");
        if (this.processLock) {
            console.log("process lock exists");
            return false;
        }

        this.processLock = true;

        var pStack  = this.getProfilesFromStack(),
            self    = this,
            keys    = Object.keys(pStack);

        console.log("Proceed " + keys.length + " indexes");

        this.clearProfileStack();

        asyncLib.eachSeries(keys, function (item, callback) {
            var splitted    = item.split(/\|/);
            console.log("Proceed " + item);
            if (splitted && splitted.length === 2) {
                self.addGeoDataToProfile(splitted[0], splitted[1], pStack[item], callback);
            }
        }, function () {
            self.processLock = false;
            console.log("Proceed finished");
        });
    },

    addGeoDataToProfile: function (profile, section, ip, callback) {
        var self = this;
        console.log("Add geo data to profile " + profile);
        this.getCoordsByIp(ip, function (error, data) {
            console.log("get coordinates: " + (data ? JSON.stringify([data.latitude, data.longitude]) : null));
            if (!error && data) {
                oWeather.now([[data.latitude, data.longitude]], function (error, forecast) {

                    if (!error && forecast) {
                        forecast = forecast[0];

                        var mainTempBlock       = forecast.values.main,
                            baseWeatherBlock    = forecast.values.weather[0],
                            windBlock           = forecast.values.wind,
                            cloudsBlock         = forecast.values.clouds;
                        console.log(JSON.stringify(forecast));

                        var profileObj = Inno.Profile(profile);

                        var pAttrs = profileObj.createAttributes({
                            weather_temp:           (1 * mainTempBlock.temp - 273.15) + "\u00B0C", // Degree symbol
                            weather_humidity:       mainTempBlock.humidity + "%",
                            weather_clouds:         cloudsBlock.all + "%",
                            weather_wind_speed:     windBlock.speed + "m/s",
                            weather_wind_direction: self.getNameByWindDegrees(windBlock.deg),
                            weather_icon:           "http://openweathermap.org/img/w/" + (baseWeatherBlock.icon) + ".png",
                            weather_ts:             Date.now()
                        });

                        profileObj.setAttributes(pAttrs);
                    } else {
                        callback();
                    }
                });
            } else {
                callback();
            }
        });
    },

    getNameByWindDegrees: function (deg) {
        var windNames   = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"],
            index       = Math.round(deg / 22.5);

        if (isNaN(index)) {
            return null;
        } else if (index > 15) {
            index = 0;
        }

        return windNames[index];
    }
};

console.log(vars);

var inno        = new Inno.InnoHelper(vars),
    db          = new sqlite3.Database('./inno.db'),
    weatherApp  = new WeatherApp(db);

var app             = express(),
    port            = 9900; // parseInt(process.env.PORT, 10);

app.use(bodyParser.json());
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.use(function (req, res, next) {
    if (res) {
        setTimeout(function () {
            if (!res.finished) {
                res.sendStatus(408);
            }
        }, appRequestTimeout);
    }

    next();
});

app.get('/', function (req, res) {
    weatherApp.getAllIpsFromCache(function (data) {
        res.send(JSON.stringify(weatherApp.getProfilesFromStack()) + JSON.stringify(data));
    });
});

app.post('/', function (req, res) {
    var profile, error, ip;
    try {
        profile = inno.getProfileFromRequest(req.body);
    } catch (e) {
        error = e.message;
    }

    ip = req.get("requestIp"); // request.body.meta

    if (!profile || !ip) {
        res.sendStatus(400);
        console.error(error || "Request from undefined host");
        return;
    }

    weatherApp.addProfileToStack(profile, ip);
    res.sendStatus(200);
});

var startApp = function () {
    app.listen(port, function () {
        console.log('Listening on port: ' + port);
    });

    setInterval(function () {
        weatherApp.addGeoDataToProfiles();
    }, 300000);
};

db.serialize(function () {
    db.run("CREATE TABLE IF NOT EXISTS geo_ip_cache (ip TEXT,latitude TEXT,longitude TEXT)");

    var checkApiKey = function () {
        inno.getAppSettings(function (error, settings) {
            if (wAppKey || (!error && settings && settings.weatherApiKey)) {
                oWeather.setAPPID(wAppKey || settings.weatherApiKey);
                startApp();
                console.log("All ok! App started successfully.");
            } else {
                console.log(error.message);
                console.log("weatherApiKey isn't found. Will wait for 2 minutes");
                setTimeout(checkApiKey, 120000);
            }
        });
    };

    checkApiKey();
});
