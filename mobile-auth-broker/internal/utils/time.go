package utils

import "time"

// NowUnix returns the current Unix timestamp
func NowUnix() int64 {
	return time.Now().Unix()
}

// Now returns the current time
func Now() time.Time {
	return time.Now()
}

// TimeFromUnix converts Unix timestamp to time.Time
func TimeFromUnix(ts int64) time.Time {
	return time.Unix(ts, 0)
}

// UnixFromTime converts time.Time to Unix timestamp
func UnixFromTime(t time.Time) int64 {
	return t.Unix()
}
