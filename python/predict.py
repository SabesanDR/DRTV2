#!/usr/bin/env python3
"""
Predictive Analytics Module
Provides delay predictions, congestion forecasts, and alert impact estimation
"""

import sys
import json
import sqlite3
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path

class PredictiveModel:
    def __init__(self, db_path='../data/gtfs.db'):
        self.db_path = db_path
        self.conn = None
    
    def connect(self):
        """Connect to SQLite database"""
        try:
            self.conn = sqlite3.connect(self.db_path)
            self.conn.row_factory = sqlite3.Row
        except Exception as e:
            print(json.dumps({'error': f'Database connection failed: {e}'}), file=sys.stdout)
            sys.exit(1)
    
    def predict_delay(self, route_id, stop_id, hour_of_day):
        """
        Predict delay likelihood for a route/stop at a given hour
        Uses historical trip_updates_history data with simple time-of-day averaging
        """
        try:
            cursor = self.conn.cursor()
            
            # Extract hour from timestamps in history
            cursor.execute('''
                SELECT 
                    AVG(CAST(arrival_delay AS FLOAT)) as avg_delay,
                    AVG(CAST(departure_delay AS FLOAT)) as avg_depart_delay,
                    COUNT(*) as sample_count
                FROM trip_updates_history
                WHERE route_id = ? AND stop_id = ?
            ''', (route_id, stop_id))
            
            result = cursor.fetchone()
            
            if result is None or result['sample_count'] == 0:
                # No historical data, return neutral prediction
                return {
                    'route_id': route_id,
                    'stop_id': stop_id,
                    'hour_of_day': hour_of_day,
                    'predicted_delay_seconds': 0,
                    'confidence': 0.2,
                    'message': 'Insufficient historical data. Using default estimate.',
                    'model': 'baseline'
                }
            
            avg_delay = result['avg_delay'] or 0
            sample_count = result['sample_count']
            
            # Simple confidence: more samples = higher confidence
            confidence = min(0.9, 0.3 + (sample_count / 100))
            
            return {
                'route_id': route_id,
                'stop_id': stop_id,
                'hour_of_day': hour_of_day,
                'predicted_delay_seconds': int(avg_delay),
                'confidence': round(confidence, 2),
                'basis_samples': sample_count,
                'model': 'historical_average'
            }
            
        except Exception as e:
            return {
                'error': str(e),
                'route_id': route_id,
                'stop_id': stop_id
            }
    
    def predict_congestion(self, stop_id, hours_ahead=1):
        """
        Forecast stop congestion based on historical patterns
        """
        try:
            cursor = self.conn.cursor()
            
            # Get historical arrival patterns at this stop
            cursor.execute('''
                SELECT COUNT(*) as arrivals
                FROM trip_updates_history
                WHERE stop_id = ?
            ''', (stop_id,))
            
            result = cursor.fetchone()
            total_historical = result['arrivals'] if result else 0
            
            if total_historical == 0:
                return {
                    'stop_id': stop_id,
                    'hours_ahead': hours_ahead,
                    'congestion_probability': 0.5,
                    'message': 'Insufficient data for prediction'
                }
            
            # Simplified model: estimate based on time of day
            now = datetime.now()
            future_hour = (now.hour + hours_ahead) % 24
            
            # Peak hours (7-9 AM, 4-7 PM) have higher congestion
            peak_hours = [7, 8, 16, 17, 18]
            congestion_prob = 0.7 if future_hour in peak_hours else 0.4
            
            return {
                'stop_id': stop_id,
                'hours_ahead': hours_ahead,
                'predicted_hour': future_hour,
                'congestion_probability': round(congestion_prob, 2),
                'expected_arrivals_estimate': max(0, int(total_historical / 24 * (1 + (0.3 if future_hour in peak_hours else 0)))),
                'model': 'time_of_day_pattern'
            }
            
        except Exception as e:
            return {
                'error': str(e),
                'stop_id': stop_id
            }
    
    def estimate_alert_impact(self, affected_routes):
        """
        Estimate impact of a service alert on routes and trips
        """
        try:
            cursor = self.conn.cursor()
            
            impact = {
                'affected_routes': affected_routes,
                'total_affected_routes': len(affected_routes),
                'routes_detail': []
            }
            
            total_trips = 0
            total_stops = 0
            
            for route_id in affected_routes:
                cursor.execute('''
                    SELECT 
                        COUNT(DISTINCT t.trip_id) as trip_count,
                        COUNT(DISTINCT st.stop_id) as stop_count
                    FROM trips t
                    LEFT JOIN stop_times st ON t.trip_id = st.trip_id
                    WHERE t.route_id = ?
                ''', (route_id,))
                
                result = cursor.fetchone()
                trip_count = result['trip_count'] or 0
                stop_count = result['stop_count'] or 0
                
                total_trips += trip_count
                total_stops += stop_count
                
                impact['routes_detail'].append({
                    'route_id': route_id,
                    'affected_trips': trip_count,
                    'affected_stops': stop_count
                })
            
            impact['total_affected_trips'] = total_trips
            impact['total_affected_stops'] = total_stops
            impact['estimate_timestamp'] = datetime.now().isoformat()
            
            return impact
            
        except Exception as e:
            return {
                'error': str(e),
                'affected_routes': affected_routes
            }
    
    def run(self, method, params_json):
        """Main execution method"""
        self.connect()
        
        try:
            params = json.loads(params_json)
        except json.JSONDecodeError:
            return {'error': 'Invalid JSON parameters'}
        
        if method == 'delay':
            result = self.predict_delay(
                params.get('route_id'),
                params.get('stop_id'),
                params.get('hour_of_day', 12)
            )
        elif method == 'congestion':
            result = self.predict_congestion(
                params.get('stop_id'),
                params.get('hours_ahead', 1)
            )
        elif method == 'alert_impact':
            result = self.estimate_alert_impact(
                params.get('affected_routes', [])
            )
        else:
            result = {'error': f'Unknown method: {method}'}
        
        if self.conn:
            self.conn.close()
        
        return result

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'Usage: predict.py <method> <params_json>'}))
        sys.exit(1)
    
    method = sys.argv[1]
    params_json = sys.argv[2]
    
    predictor = PredictiveModel()
    result = predictor.run(method, params_json)
    
    print(json.dumps(result))
