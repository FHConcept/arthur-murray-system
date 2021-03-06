#!/usr/bin/env node

'use strict'; // eslint-disable-line strict, lines-around-directive

const storage = require('../src/lib/storage');
const constants = require('../src/lib/constants');

const axios = require('axios');
const Promise = require('bluebird');
const _ = require('lodash');

const { ConnectionPool, RepoFactory } = storage;
const conn = new ConnectionPool(constants.STORE.TYPES.MONGO_DB);
const repo = RepoFactory.manufacture(constants.STORE.TYPES.MONGO_DB);

const tableName = 'financeReport';

const arthurMurrayUrl = 'https://reporting.arthurmurray.com';
const arthurMurrayHttpClient = axios.create({
  baseURL: arthurMurrayUrl,
});

repo.on(conn, 'connect').then(() => {
  console.log('Connection established successfully.');
});

repo.on(conn, 'error').then(printErrorMsg);

const fetchReportsFromOfficialSource = async (week, yearNumber) => {
  const {
    data: { access_token: accessToken },
  } = await arthurMurrayHttpClient.get('/oauth/v2/token', {
    params: {
      client_id: '5e4ab19f047c2a16883c6f58_5ranbk2z53kssgkwc8sc0kgww8o8ko0444k004co8ws4s48w4k',
      client_secret: '3sctxu7wz06c8w0oko0ow4sog8kg08o4k80gkkw4k8wwcow4ws',
      grant_type: 'password',
      username: 'info@dancecomp.org',
      password: 'dance1',
    },
  });

  return arthurMurrayHttpClient.get('/api/v1/statistics/sps', {
    params: {
      frozen: true,
      week_number: week,
      week_year: yearNumber,
      access_token: accessToken,
    },
  });
};

const flattenObject = obj => {
  const flattened = {};

  Object.keys(obj).forEach(key => {
    if (key !== 'historical') {
      if (Array.isArray(obj[key]) && key === 'submitted_weeks') {
        flattened[key] = obj[key][0]; // eslint-disable-line
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        Object.assign(flattened, flattenObject(obj[key]));
      } else {
        flattened[key] = obj[key];
      }
    }
  });

  return flattened;
};

const syncWeeklyReports = async yearNumber => {
  try {
    const today = new Date();
    const weekNumber = today.getWeek();
    const weeks = [];

    for (let i = 1; i <= weekNumber; i += 1) {
      weeks.push(i);
    }

    let allWeeksData = await Promise.all(
      weeks.map(async week => {
        const { data: reportsResData } = await fetchReportsFromOfficialSource(week, yearNumber);

        reportsResData.weekNumber = week;
        return reportsResData;
      })
    );

    allWeeksData = allWeeksData.filter(week => week.sps.length);

    const validStudioData = [];

    for (let i = 0; i < allWeeksData.length; i += 1) {
      for (let j = 0; j < allWeeksData[i].sps.length; j += 1) {
        for (let k = 0; k < allWeeksData[i].sps[j].length; k += 1) {
          const current = allWeeksData[i].sps[j][k];

          if (current && current.report.submitted_weeks.length) {
            const flattenCurrent = flattenObject(current);

            flattenCurrent.year = yearNumber;
            validStudioData.push(flattenCurrent);
          }
        }
      }
    }

    const groupByName = _.groupBy(validStudioData, 'name');

    for (const studios in groupByName) {
      if (groupByName.hasOwnProperty(studios)) {
        let currOriginalSold = 0;
        let currExtensionSold = 0;
        let lessonsTaught = 0;
        let lessonsSold = 0;

        groupByName[studios]
          .sort((s1, s2) => s1.submitted_weeks - s2.submitted_weeks)
          .map(s => {
            /* eslint-disable no-param-reassign */
            s.miscellaneousVsGross = s.cash === 0 ? 0 : s.cash / (s.cash + s.miscellaneous);
            s.bookedVsContact = s.booked === 0 || s.contact === 0 ? 0 : s.booked / s.contact;
            s.showedVsOriginalSold =
              s.original_sold === 0 || s.contact === 0 ? 0 : s.original_sold / s.showed;
            currOriginalSold += s.original_sold;
            currExtensionSold += s.extension_sold;
            lessonsTaught += s.lessons_interviewed + s.lessons_renewed;
            s.weeklyLessonsSold =
              s.pre_original_units + s.original_units + s.extension_units + s.renewal_units;
            lessonsSold += s.weeklyLessonsSold;
            s.originalSoldVsExtensionSold =
              currOriginalSold === 0 || currExtensionSold === 0
                ? 0
                : currExtensionSold / currOriginalSold;
            s.yearToDateLessonsSold = lessonsSold;

            s.lessonsTaughtVsLessonsSold =
              lessonsTaught === 0 || lessonsSold === 0 ? 0 : lessonsTaught / lessonsSold;
            /* eslint-enable no-param-reassign */
            return s;
          });
      }
    }

    const promises = [];

    for (let i = 0; i < validStudioData.length; i += 1) {
      promises.push(
        repo.update(
          conn,
          tableName,
          { name: validStudioData[i].name, submitted_weeks: validStudioData[i].submitted_weeks },
          validStudioData[i],
          true
        )
      );
    }

    await Promise.all(promises);
    console.log('Successfully insert all the datas');

    repo.close(conn);
    console.log('Closed connection');
  } catch (err) {
    printErrorMsg(err);
  }
};

// eslint-disable-next-line no-extend-native
Date.prototype.getWeek = function() {
  const onejan = new Date(this.getFullYear(), 0, 1);

  return Math.ceil(((this - onejan) / 86400000 + onejan.getDay() + 1) / 7);
};

function printErrorMsg(err) {
  console.log(`Something breaks - ${err}`);
}

const yearNumber = process.argv[process.argv.length - 1];

syncWeeklyReports(/20[0-9]{2}/.test(yearNumber) ? yearNumber : new Date().getFullYear());
